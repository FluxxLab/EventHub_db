import type { FlowProducer, Queue } from 'bullmq';
import type { Repository } from 'typeorm';
import type { RealtimeService } from '../common/realtime/realtime.service';
import type { DelegatesService } from '../delegate/delegates.service';
import type { DeviceToken } from './entities/device-token.entity';
import type { Notification } from './entities/notification.entity';
import {
  ChunkJob,
  DISPATCH_JOB_OPTIONS,
  NotificationsProcessor,
  PUSH_CHUNK_SIZE,
  chunk,
} from './notifications.processor';

/**
 * A segment broadcast to 3,000 delegates is fanned out into chunk jobs of at
 * most 500 devices, each retried on its own, so a failure halfway through
 * never re-pushes the phones earlier chunks already reached. The row is
 * stamped sent once, after every chunk has finished.
 */
const announcement = {
  id: 'n1',
  title: 'Plenary moved',
  body: 'Now in Hall B',
  segment: 'all',
  category: null,
  sessionId: null,
  linkUrl: null,
  sentAt: null,
} as unknown as Notification;

function build(deviceCount: number, row: Notification | null = announcement) {
  const tokens = Array.from({ length: deviceCount }, (_, i) => ({
    id: `dt${i}`,
    delegateId: `d${i}`,
    token: `tok-${String(i).padStart(5, '0')}`,
    platform: i % 2 ? 'ios' : 'android',
  }));
  const notifications = {
    findOneBy: jest.fn().mockResolvedValue(row),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const deviceTokens = {
    find: jest.fn().mockResolvedValue(tokens),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
  };
  const delegates = {
    idsForSegment: jest.fn().mockResolvedValue(tokens.map((t) => t.delegateId)),
  };
  const push = {
    sendToTokens: jest.fn().mockResolvedValue({ invalidTokens: [] }),
  };
  const realtime = { emitToRoom: jest.fn(), emitGlobal: jest.fn() };
  const queue = { getJob: jest.fn().mockResolvedValue(undefined) };
  const flow = { add: jest.fn().mockResolvedValue({}) };
  const processor = new NotificationsProcessor(
    realtime as unknown as RealtimeService,
    delegates as unknown as DelegatesService,
    notifications as unknown as Repository<Notification>,
    push,
    deviceTokens as unknown as Repository<DeviceToken>,
    queue as unknown as Queue,
    flow as unknown as FlowProducer,
  );
  return {
    processor,
    notifications,
    deviceTokens,
    push,
    realtime,
    queue,
    flow,
  };
}

type AnyJob = Parameters<NotificationsProcessor['process']>[0];
const job = (name: string, data: unknown, extra: object = {}): AnyJob =>
  ({ name, data, ...extra }) as unknown as AnyJob;

describe('chunk', () => {
  it('slices into runs of at most the size, keeping order', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 500)).toEqual([]);
  });
});

describe('NotificationsProcessor segment broadcast', () => {
  it('fans 1,201 devices out into three chunks of <= 500 under one finaliser', async () => {
    const { processor, flow, push, notifications } = build(1201);
    await processor.process(job('dispatch', { notificationId: 'n1' }));

    // the dispatch itself pushes nothing and stamps nothing
    expect(push.sendToTokens).not.toHaveBeenCalled();
    expect(notifications.update).not.toHaveBeenCalled();

    expect(flow.add).toHaveBeenCalledTimes(1);
    const [tree] = flow.add.mock.calls[0] as [
      {
        name: string;
        opts: { jobId: string; attempts: number };
        children: {
          name: string;
          data: ChunkJob;
          opts: Record<string, unknown>;
        }[];
      },
    ];
    expect(tree.name).toBe('dispatch-finalize');
    expect(tree.opts).toMatchObject({ jobId: 'notif-final-n1', attempts: 3 });
    expect(tree.children.map((c) => c.data.targets.length)).toEqual([
      500, 500, 201,
    ]);
    // every device exactly once across the chunks
    const all = tree.children.flatMap((c) =>
      c.data.targets.map((t) => t.token),
    );
    expect(new Set(all).size).toBe(1201);
    expect(tree.children[0].data.targets[0]).toEqual({
      token: 'tok-00000',
      platform: 'android',
    });
    for (const [i, c] of tree.children.entries()) {
      expect(c.name).toBe('dispatch-chunk');
      expect(c.opts).toMatchObject({
        ...DISPATCH_JOB_OPTIONS,
        jobId: `notif-chunk-n1-${i}`,
        ignoreDependencyOnFailure: true,
      });
    }
    expect(PUSH_CHUNK_SIZE).toBe(500);
  });

  it('does not fan out twice when the dispatch is retried', async () => {
    const { processor, flow, queue } = build(10);
    queue.getJob.mockResolvedValue({ id: 'notif-final-n1' });
    await processor.process(job('dispatch', { notificationId: 'n1' }));
    expect(flow.add).not.toHaveBeenCalled();
  });

  it('skips a notification that is already sent', async () => {
    const { processor, flow } = build(10, {
      ...announcement,
      sentAt: new Date(),
    });
    await processor.process(job('dispatch', { notificationId: 'n1' }));
    expect(flow.add).not.toHaveBeenCalled();
  });

  it('stamps and emits at once when there is no device to push to', async () => {
    const { processor, flow, notifications, realtime } = build(0);
    await processor.process(job('dispatch', { notificationId: 'n1' }));
    expect(flow.add).not.toHaveBeenCalled();
    expect(notifications.update).toHaveBeenCalledWith('n1', {
      sentAt: expect.any(Date),
    });
    expect(realtime.emitToRoom).toHaveBeenCalledTimes(1);
    expect(realtime.emitGlobal).toHaveBeenCalledWith('notification:sent', {
      id: 'n1',
    });
  });

  it('pushes a chunk to exactly its own devices and prunes dead tokens', async () => {
    const { processor, push, deviceTokens, notifications } = build(0);
    push.sendToTokens.mockResolvedValue({ invalidTokens: ['tok-b'] });
    const targets = [
      { token: 'tok-a', platform: 'ios' },
      { token: 'tok-b', platform: 'android' },
    ];
    await processor.process(
      job('dispatch-chunk', {
        notificationId: 'n1',
        targets,
        index: 1,
        total: 3,
      }),
    );
    expect(push.sendToTokens).toHaveBeenCalledWith(
      targets,
      'Plenary moved',
      'Now in Hall B',
      expect.objectContaining({ notificationId: 'n1' }),
    );
    expect(deviceTokens.delete).toHaveBeenCalledTimes(1);
    // a chunk never stamps the row: only the finaliser does
    expect(notifications.update).not.toHaveBeenCalled();
  });

  it('lets a failed chunk throw so BullMQ retries that chunk alone', async () => {
    const { processor, push } = build(0);
    push.sendToTokens.mockRejectedValue(new Error('FCM 503'));
    await expect(
      processor.process(
        job('dispatch-chunk', {
          notificationId: 'n1',
          targets: [{ token: 't', platform: 'ios' }],
          index: 0,
          total: 1,
        }),
      ),
    ).rejects.toThrow('FCM 503');
  });

  it('stamps sentAt and emits once, when the finaliser runs after every chunk', async () => {
    const { processor, notifications, realtime } = build(0);
    await processor.process(
      job(
        'dispatch-finalize',
        { notificationId: 'n1' },
        { getIgnoredChildrenFailures: jest.fn().mockResolvedValue({}) },
      ),
    );
    expect(notifications.update).toHaveBeenCalledWith('n1', {
      sentAt: expect.any(Date),
    });
    expect(realtime.emitToRoom).toHaveBeenCalledWith(
      'notifications:all',
      'notification',
      expect.objectContaining({ id: 'n1' }),
    );
  });

  it('still stamps a partial broadcast (recording the failed chunks) rather than re-pushing everyone', async () => {
    const { processor, notifications } = build(0);
    const failures = jest
      .fn()
      .mockResolvedValue({ 'bull:notifications:notif-chunk-n1-2': 'FCM 503' });
    await processor.process(
      job(
        'dispatch-finalize',
        { notificationId: 'n1' },
        { getIgnoredChildrenFailures: failures },
      ),
    );
    expect(failures).toHaveBeenCalled();
    expect(notifications.update).toHaveBeenCalledTimes(1);
  });
});
