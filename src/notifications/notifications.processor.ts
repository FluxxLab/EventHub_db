import { In, Repository } from 'typeorm';
import {
  InjectFlowProducer,
  InjectQueue,
  Processor,
  WorkerHost,
} from '@nestjs/bullmq';
import { Inject, Logger, Optional } from '@nestjs/common';
import { FlowProducer, Job, Queue } from 'bullmq';
import { RealtimeService, Rooms } from '../common/realtime/realtime.service';
import { DelegatesService } from '../delegate/delegates.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Notification } from './entities/notification.entity';
import { DeviceToken } from './entities/device-token.entity';
import { PUSH_SENDER } from './push/push-sender.interface';
import type { PushSender, PushTarget } from './push/push-sender.interface';
import { WHATSAPP_SENDER } from './whatsapp/whatsapp-sender.interface';
import type { WhatsAppSender } from './whatsapp/whatsapp-sender.interface';

/** Recipients per WhatsApp job: small, so a retry re-sends little. */
export const WHATSAPP_CHUNK_SIZE = 50;

export interface WhatsAppChunkJob {
  notificationId: string;
  recipients: { id: string; phone: string }[];
}

export const whatsappJobId = (notificationId: string, index: number) =>
  `notif-wa-${notificationId}-${index}`;

export interface DirectJob {
  delegateId: string;
  title: string;
  body: string;
  category: string | null;
  /** The session this is about, so the tap opens it (reminders). */
  sessionId?: string | null;
}

/** Largest number of devices one push job carries (FCM multicast's cap). */
export const PUSH_CHUNK_SIZE = 500;

/** The flow producer that fans a broadcast out into chunk jobs. */
export const NOTIFICATIONS_FLOW = 'notifications-flow';

/**
 * Retry policy for every broadcast job (the dispatch, each chunk, and the
 * finaliser): three tries, 5 s then 10 s apart, so an FCM or Postgres blip
 * does not lose an announcement.
 */
export const DISPATCH_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
};

export interface ChunkJob {
  notificationId: string;
  /** The exact devices this chunk pushes to, fixed when the flow was built. */
  targets: PushTarget[];
  index: number;
  total: number;
}

/**
 * Job ids are deterministic so a retried dispatch cannot add a second flow.
 * (BullMQ refuses ':' in custom ids, hence the dashes.)
 */
export const finalizeJobId = (notificationId: string) =>
  `notif-final-${notificationId}`;
export const chunkJobId = (notificationId: string, index: number) =>
  `notif-chunk-${notificationId}-${index}`;

/** `items` in consecutive slices of at most `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

@Processor('notifications')
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);

  constructor(
    private readonly realtime: RealtimeService,
    private readonly delegate: DelegatesService,
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
    @Inject(PUSH_SENDER)
    private readonly push: PushSender,
    @InjectRepository(DeviceToken)
    private readonly deviceTokens: Repository<DeviceToken>,
    @InjectQueue('notifications')
    private readonly queue: Queue,
    @InjectFlowProducer(NOTIFICATIONS_FLOW)
    private readonly flow: FlowProducer,
    // optional so the unit specs, which build the processor by hand, need not supply it
    @Optional()
    @Inject(WHATSAPP_SENDER)
    private readonly whatsapp?: WhatsAppSender,
  ) {
    super();
  }

  /**
   * Job shapes on one queue.
   *
   * 'dispatch' is the segment broadcast an organiser composes. It no longer
   * pushes itself: it resolves the devices once and fans them out as a
   * BullMQ flow - one 'dispatch-chunk' child per <= PUSH_CHUNK_SIZE devices
   * under one 'dispatch-finalize' parent. Each chunk retries on its own, so a
   * failure halfway through a 3,000-device broadcast re-sends at most that
   * chunk, never the devices earlier chunks already reached. The parent runs
   * only once every chunk has finished (succeeded, or exhausted its retries)
   * and is the one place `sentAt` is stamped and the live row emitted.
   *
   * 'direct' is a notification with a single recipient, raised by another
   * module - a connection, for instance. It arrives as a queued job rather
   * than a service call because notifications already depends on delegates,
   * and calling back the other way would make that a cycle.
   */
  async process(
    job: Job<{ notificationId: string } | DirectJob | ChunkJob>,
  ): Promise<void> {
    switch (job.name) {
      case 'direct':
        return this.sendDirect(job.data as DirectJob);
      case 'dispatch-chunk':
        return this.sendChunk(job.data as ChunkJob);
      case 'dispatch-finalize':
        return this.finalize(job as Job<{ notificationId: string }>);
      case 'whatsapp-chunk':
        return this.sendWhatsAppChunk(job.data as WhatsAppChunkJob);
      default:
        return this.dispatch(
          (job.data as { notificationId: string }).notificationId,
        );
    }
  }

  private async dispatch(notificationId: string): Promise<void> {
    const notification = await this.notifications.findOneBy({
      id: notificationId,
    });

    // Idempotent: a notification already sent, or already fanned out by an
    // earlier attempt of this job, is left alone.
    if (!notification || notification.sentAt) return;
    if (await this.queue.getJob(finalizeJobId(notification.id))) return;

    const delegateIds = await this.delegate.idsForSegment(
      notification.segment,
      notification.editionId,
      notification.ticketTypeIds ?? [],
    );
    if (notification.whatsapp)
      await this.queueWhatsApp(notification, delegateIds);

    // kept as {token, platform}, not bare strings: the sender routes on
    // `platform`. Ordered so the chunks come out the same on every attempt.
    const tokens = delegateIds.length
      ? await this.deviceTokens.find({
          where: { delegateId: In(delegateIds) },
          order: { token: 'ASC' },
        })
      : [];

    /**
     * Delivering to nobody is otherwise indistinguishable from success: the
     * row still gets stamped sent, the admin sees a green tick, and no device
     * ever rings. A segment with delegates but no registered tokens means the
     * app never called POST /notifications/register - Expo Go, the Settings
     * push toggle, or a denied permission.
     */
    if (delegateIds.length > 0 && tokens.length === 0) {
      this.logger.warn(
        `"${notification.title}" reached 0 devices: ${delegateIds.length} delegate(s) in segment "${notification.segment}", none with a registered push token`,
      );
    } else {
      this.logger.log(
        `"${notification.title}" -> ${tokens.length} device(s) in segment "${notification.segment}"`,
      );
    }

    if (tokens.length === 0) {
      // nothing to push; the inbox row and the live emit still go out
      await this.markSent(notification);
      return;
    }

    const chunks = chunk(
      tokens.map((t) => ({ token: t.token, platform: t.platform })),
      PUSH_CHUNK_SIZE,
    );
    await this.flow.add({
      name: 'dispatch-finalize',
      queueName: 'notifications',
      data: { notificationId: notification.id },
      opts: { ...DISPATCH_JOB_OPTIONS, jobId: finalizeJobId(notification.id) },
      children: chunks.map((targets, index) => {
        const data: ChunkJob = {
          notificationId: notification.id,
          targets,
          index,
          total: chunks.length,
        };
        return {
          name: 'dispatch-chunk',
          queueName: 'notifications',
          data,
          opts: {
            ...DISPATCH_JOB_OPTIONS,
            jobId: chunkJobId(notification.id, index),
            // a chunk that exhausts its retries must not strand the parent
            // in waiting-children forever; the parent records it as failed
            ignoreDependencyOnFailure: true,
          },
        };
      }),
    });
  }

  /**
   * WhatsApp copies of a broadcast, for the recipients who opted in. Queued
   * as their own jobs beside the push flow, so a slow or failing WhatsApp
   * never holds up the push or the inbox. Deterministic job ids make a
   * retried dispatch add nothing twice.
   */
  private async queueWhatsApp(
    notification: Notification,
    delegateIds: string[],
  ): Promise<void> {
    const contacts = await this.delegate.whatsappContacts(delegateIds);
    this.logger.log(
      `"${notification.title}" -> ${contacts.length} WhatsApp recipient(s)`,
    );
    const chunks = chunk(contacts, WHATSAPP_CHUNK_SIZE);
    for (const [index, recipients] of chunks.entries()) {
      const data: WhatsAppChunkJob = {
        notificationId: notification.id,
        recipients,
      };
      await this.queue.add('whatsapp-chunk', data, {
        ...DISPATCH_JOB_OPTIONS,
        jobId: whatsappJobId(notification.id, index),
      });
    }
  }

  /**
   * Sends one WhatsApp slice. A number WhatsApp refuses (not on WhatsApp,
   * opted out on their side) is logged and skipped, so one bad number never
   * makes the slice retry and message everyone else in it twice.
   */
  private async sendWhatsAppChunk(data: WhatsAppChunkJob): Promise<void> {
    if (!this.whatsapp) return;
    const notification = await this.notifications.findOneBy({
      id: data.notificationId,
    });
    if (!notification) return;
    let failed = 0;
    for (const r of data.recipients) {
      try {
        await this.whatsapp.sendAnnouncement(
          r.phone,
          notification.title,
          notification.body,
        );
      } catch {
        failed += 1;
      }
    }
    if (failed)
      this.logger.warn(
        `"${notification.title}": ${failed} of ${data.recipients.length} WhatsApp message(s) in a slice failed`,
      );
  }

  /** One slice of a broadcast. A throw retries this slice alone. */
  private async sendChunk(data: ChunkJob): Promise<void> {
    const notification = await this.notifications.findOneBy({
      id: data.notificationId,
    });
    // retracted while the broadcast was in flight: stop pushing it
    if (!notification) return;

    const { invalidTokens } = await this.push.sendToTokens(
      data.targets,
      notification.title,
      notification.body,
      // so a tap opens the inbox at this announcement rather than wherever
      // the delegate happened to leave the app
      {
        category: notification.category ?? 'announcement',
        notificationId: notification.id,
        ...(notification.sessionId
          ? { sessionId: notification.sessionId }
          : {}),
        ...(notification.linkUrl ? { linkUrl: notification.linkUrl } : {}),
      },
    );
    if (invalidTokens.length)
      await this.deviceTokens.delete({ token: In(invalidTokens) });
  }

  /**
   * Runs once every chunk has finished. Chunks that gave up after their
   * retries are logged with their count so a partial broadcast is visible,
   * and the row is still stamped: the devices that were reached have it,
   * and re-pushing the whole segment to recover a slice would ring every
   * phone that already rang.
   */
  private async finalize(job: Job<{ notificationId: string }>): Promise<void> {
    const notification = await this.notifications.findOneBy({
      id: job.data.notificationId,
    });
    if (!notification || notification.sentAt) return;
    const failed = Object.keys(await job.getIgnoredChildrenFailures()).length;
    if (failed > 0) {
      this.logger.warn(
        `"${notification.title}" partially delivered: ${failed} push chunk(s) of up to ${PUSH_CHUNK_SIZE} devices failed after retries`,
      );
    }
    await this.markSent(notification);
  }

  private async markSent(notification: Notification): Promise<void> {
    await this.notifications.update(notification.id, { sentAt: new Date() });
    // Staff screens (the console's display boards) refetch on this. Only the
    // id goes out, as with notification:deleted; the content stays behind auth.
    this.realtime.emitGlobal('notification:sent', { id: notification.id });
    // The segment room is every delegate in the segment, whatever their event:
    // one event's announcement is not shown to the others' open apps. Its
    // delegates still get the push, and it is in their inbox on next open.
    if (notification.editionId) return;
    this.realtime.emitToRoom(
      Rooms.notifications(notification.segment),
      'notification',
      {
        id: notification.id,
        title: notification.title,
        body: notification.body,
        category: notification.category,
        segment: notification.segment,
        // so a row that arrives live is tappable like one that was fetched
        sessionId: notification.sessionId,
        linkUrl: notification.linkUrl,
      },
    );
  }

  /**
   * One recipient: persisted so it appears in their inbox, pushed to their
   * devices, and emitted on their personal room so the app marks it unread
   * while they are looking at another screen.
   */
  private async sendDirect(data: DirectJob): Promise<void> {
    const notification = await this.notifications.save(
      this.notifications.create({
        title: data.title,
        body: data.body,
        category: data.category,
        sessionId: data.sessionId ?? null,
        delegateId: data.delegateId,
        // stamped here rather than after the push: the row is the delegate's
        // copy, and it should survive in their inbox even if no device of
        // theirs is registered to receive it
        sentAt: new Date(),
      }),
    );

    const tokens = await this.deviceTokens.findBy({
      delegateId: data.delegateId,
    });

    if (tokens.length === 0) {
      // Expected in Expo Go and for anyone who declined the permission - the
      // inbox entry above is still there when they next open the app.
      this.logger.log(
        `direct "${data.title}" -> no registered device for ${data.delegateId}`,
      );
    } else {
      const { invalidTokens } = await this.push.sendToTokens(
        tokens,
        data.title,
        data.body,
        {
          category: data.category ?? 'announcement',
          notificationId: notification.id,
          ...(data.sessionId ? { sessionId: data.sessionId } : {}),
        },
      );
      if (invalidTokens.length)
        await this.deviceTokens.delete({ token: In(invalidTokens) });
    }

    this.realtime.emitToRoom(Rooms.network(data.delegateId), 'notification', {
      id: notification.id,
      title: notification.title,
      body: notification.body,
      category: notification.category,
      segment: notification.segment,
    });
  }
}
