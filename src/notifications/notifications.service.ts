import { EditionAccessService } from '../common/edition-scope/edition-access.service';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Raw, Repository } from 'typeorm';
import { DeviceToken } from './entities/device-token.entity';
import { InjectQueue } from '@nestjs/bullmq';
import { RealtimeService } from '../common/realtime/realtime.service';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { Notification } from './entities/notification.entity';
import { NotificationRead } from './entities/notification-read.entity';
import { Queue } from 'bullmq';
import { AudienceSegment } from './entities/notification.entity';
import { DelegatesService } from '../delegate/delegates.service';
import { AccessTier } from '../delegate/entities/delegate.entity';
import { DISPATCH_JOB_OPTIONS } from './notifications.processor';
import { WHATSAPP_SENDER } from './whatsapp/whatsapp-sender.interface';
import type { WhatsAppSender } from './whatsapp/whatsapp-sender.interface';

@Injectable()
export class NotificationsService {
  constructor(
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
    @InjectRepository(NotificationRead)
    private readonly reads: Repository<NotificationRead>,
    @InjectRepository(DeviceToken)
    private readonly deviceTokens: Repository<DeviceToken>,
    @InjectQueue('notifications')
    private readonly queue: Queue,
    private readonly realtime: RealtimeService,
    private readonly delegates: DelegatesService,
    /** An event organiser's events, for their sent list. Optional for the hand-built specs. */
    @Optional()
    private readonly access?: EditionAccessService,
    @Optional()
    @Inject(WHATSAPP_SENDER)
    private readonly whatsapp?: WhatsAppSender,
  ) {}

  /**
   * How many delegates an announcement to this segment would reach on
   * WhatsApp (opted in, with a phone), and whether messages really leave:
   * the console shows it before an organiser pays for a send.
   */
  async whatsappReach(
    segment: string,
    editionId: string | null,
    ticketTypeIds: string[] = [],
  ): Promise<{ recipients: number; live: boolean }> {
    const ids = await this.delegates.idsForSegment(
      segment,
      editionId,
      editionId ? ticketTypeIds : [],
    );
    const contacts = await this.delegates.whatsappContacts(ids);
    return { recipients: contacts.length, live: this.whatsapp?.live ?? false };
  }

  async announce(dto: CreateNotificationDto): Promise<Notification> {
    const ticketTypeIds = [...new Set(dto.ticketTypeIds ?? [])];
    if (ticketTypeIds.length) {
      if (!dto.editionId) {
        throw new BadRequestException(
          'Ticket tiers belong to an event: choose the event to send to',
        );
      }
      const known = await this.notifications.query<{ id: string }[]>(
        `SELECT id FROM ticket_types WHERE "editionId" = $1 AND id = ANY($2::uuid[])`,
        [dto.editionId, ticketTypeIds],
      );
      if (known.length !== ticketTypeIds.length) {
        throw new BadRequestException(
          "Those ticket tiers are not this event's. Refresh and choose again.",
        );
      }
    }
    const notification = await this.notifications.save(
      this.notifications.create({
        ...dto,
        ticketTypeIds,
        // the composer sends '' for a target the operator left alone
        sessionId: dto.sessionId?.trim() ? dto.sessionId.trim() : null,
        linkUrl: dto.linkUrl?.trim() ? dto.linkUrl.trim() : null,
        // null: everyone in the segment; an edition: its delegates only
        editionId: dto.editionId ?? null,
      }),
    );

    // retried with backoff; the processor fans it out into <= 500-device
    // chunks that each retry on their own (see NotificationsProcessor)
    await this.queue.add(
      'dispatch',
      { notificationId: notification.id },
      DISPATCH_JOB_OPTIONS,
    );

    /**
     * Admin gets a 201 in milliseconds;
     * sending happens in the worker
     */
    return notification;
  }

  async registerDevice(
    delegateId: string,
    token: string,
    platform: string,
  ): Promise<void> {
    await this.deviceTokens
      .createQueryBuilder()
      .insert()
      .values({ delegateId, token, platform })
      .orUpdate(['delegateId', 'platform'], ['token'])
      .execute();
  }

  // Drop a device so it stops receiving push. Scoped to the caller: a token can
  // only be removed by the delegate it is currently registered to, so knowing
  // someone else's token is not enough to silence their phone.
  async unregisterDevice(delegateId: string, token: string): Promise<void> {
    await this.deviceTokens.delete({ delegateId, token });
  }

  /**
   * The segments a delegate can read back must be the segments they were sent,
   * or an announcement arrives as a push and then cannot be found in the app.
   * Membership is resolved by the same code that picks push recipients rather
   * than a second, hand-maintained list.
   */
  async inboxFor(user: {
    id: string;
    role: AccessTier;
  }): Promise<(Notification & { read: boolean })[]> {
    const staff =
      user.role === AccessTier.ADMIN || user.role === AccessTier.EVENT_ADMIN;
    const segments = staff
      ? // Organisers need to see everything that went out, from any device.
        Object.values(AudienceSegment)
      : await this.delegates.segmentsFor(user.id);
    // Organisers see every event's; an event organiser their events'; a
    // delegate the events they hold a ticket for or took part in.
    const editions =
      user.role === AccessTier.ADMIN
        ? null
        : user.role === AccessTier.EVENT_ADMIN
          ? ((await this.access?.editionsOf(user.id)) ?? [])
          : await this.editionsOf(user.id);
    // staff see every announcement; a delegate the untargeted ones, and those
    // for ticket tiers they hold, so the inbox matches who got the push
    const tiers = staff ? null : await this.ticketTypesOf(user.id);
    const broadcast = {
      segment: In(segments),
      sentAt: Not(IsNull()),
      delegateId: IsNull(),
      ...(tiers
        ? {
            ticketTypeIds: Raw(
              (column) =>
                tiers.length
                  ? `(cardinality(${column}) = 0 OR ${column} && ARRAY[:...holderTiers]::uuid[])`
                  : `cardinality(${column}) = 0`,
              tiers.length ? { holderTiers: tiers } : {},
            ),
          }
        : {}),
    };

    const rows = await this.notifications.find({
      where: [
        // broadcasts to everyone in the segments this delegate belongs to
        ...(user.role === AccessTier.EVENT_ADMIN
          ? []
          : [{ ...broadcast, ...(editions ? { editionId: IsNull() } : {}) }]),
        // and those sent to the delegates of their events
        ...(editions?.length
          ? [{ ...broadcast, editionId: In(editions) }]
          : []),
        // and anything addressed to them personally, whatever its segment
        { delegateId: user.id, sentAt: Not(IsNull()) },
      ],
      order: { sentAt: 'DESC' },
      take: 50,
    });
    if (rows.length === 0) return [];
    const reads = await this.reads.find({
      where: { delegateId: user.id, notificationId: In(rows.map((r) => r.id)) },
    });
    const read = new Set(reads.map((r) => r.notificationId));
    return rows.map((r) => ({ ...r, read: read.has(r.id) }));
  }

  /** The ticket tiers a delegate holds, at any event. */
  private async ticketTypesOf(delegateId: string): Promise<string[]> {
    const rows = await this.notifications.query<{ ticketTypeId: string }[]>(
      `SELECT DISTINCT t."ticketTypeId" FROM tickets t WHERE t."delegateId" = $1`,
      [delegateId],
    );
    return rows.map((r) => r.ticketTypeId);
  }

  /**
   * The events a delegate belongs to: tickets, plus sessions they saved or
   * attended - the same audience an event's notifications are sent to.
   */
  private async editionsOf(delegateId: string): Promise<string[]> {
    const rows = await this.notifications.query<{ editionId: string }[]>(
      `SELECT t."editionId" FROM tickets t WHERE t."delegateId" = $1
       UNION
       SELECT s."editionId" FROM session_bookmarks b JOIN sessions s ON s.id = b."sessionId" WHERE b."delegateId" = $1 AND s."editionId" IS NOT NULL
       UNION
       SELECT s."editionId" FROM session_attendance a JOIN sessions s ON s.id = a."sessionId" WHERE a."delegateId" = $1 AND s."editionId" IS NOT NULL`,
      [delegateId],
    );
    return rows.map((r) => r.editionId);
  }

  /**
   * Record that a delegate opened a notification. Idempotent: opening it
   * twice is one row, and a notification that has since been retracted is
   * simply ignored rather than an error the app has to explain.
   */
  async markRead(delegateId: string, notificationId: string): Promise<void> {
    const exists = await this.notifications.existsBy({ id: notificationId });
    if (!exists) return;
    await this.reads
      .createQueryBuilder()
      .insert()
      .values({ delegateId, notificationId })
      .orIgnore()
      .execute();
  }

  /**
   * Admin retraction. The row goes, so it leaves every inbox on the next
   * fetch, and the broadcast removes it from inboxes that are open right now.
   * Push notifications already delivered to phones cannot be recalled.
   */
  async remove(id: string): Promise<void> {
    const existing = await this.notifications.findOneBy({ id });
    if (!existing) throw new NotFoundException('Notification not found');
    await this.notifications.delete({ id });
    this.realtime.emitGlobal('notification:deleted', { id });
  }
}
