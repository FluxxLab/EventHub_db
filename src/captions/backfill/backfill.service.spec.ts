import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BackfillService } from './backfill.service';

const KEY = 'caption-backfill/3f0c6c1e-4c0e-4f43-9d55-8b8f5a6f2a10';
const JOB_ID = 'backfill-3f0c6c1e-4c0e-4f43-9d55-8b8f5a6f2a10';
const T0 = Date.parse('2026-10-17T09:00:00.000Z');

function build(
  opts: {
    sessions?: unknown[];
    said?: number[];
    utterances?: unknown[];
  } = {},
) {
  const sessionQb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(opts.sessions ?? []),
  };
  const saidQb = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getRawMany: jest
      .fn()
      .mockResolvedValue((opts.said ?? []).map((at) => ({ at: String(at) }))),
  };
  const saved: unknown[] = [];
  const segments = {
    create: jest.fn((v: unknown) => v),
    createQueryBuilder: jest.fn(() => saidQb),
    manager: {
      createQueryBuilder: jest.fn(() => sessionQb),
      transaction: (fn: (m: unknown) => Promise<unknown>) =>
        fn({
          save: jest.fn((_e: unknown, rows: unknown[]) => {
            saved.push(...rows);
            return Promise.resolve(rows);
          }),
        }),
    },
  };
  const transcription = {
    openStream: jest.fn(),
    transcribeUrl: jest.fn().mockResolvedValue(opts.utterances ?? []),
  };
  const queue = {
    getJob: jest.fn().mockResolvedValue(undefined),
    add: jest.fn().mockResolvedValue({}),
  };
  const storage = {
    presignUpload: jest
      .fn()
      .mockResolvedValue({ uploadUrl: 'https://s3/put', key: KEY }),
    presignRead: jest.fn().mockResolvedValue('https://s3/get'),
    headObject: jest.fn().mockResolvedValue({ size: 10 }),
    deleteObject: jest.fn().mockResolvedValue(undefined),
  };
  const editions = { current: jest.fn().mockResolvedValue({ id: 'ed-1' }) };
  const captions = {
    termsFor: jest.fn().mockResolvedValue(['Pitchathon']),
  };
  const realtime = { emitToRoom: jest.fn() };
  const service = new BackfillService(
    segments as never,
    transcription,
    queue as never,
    storage as never,
    editions as never,
    captions as never,
    realtime as never,
  );
  return {
    service,
    queue,
    storage,
    transcription,
    sessionQb,
    saved,
    realtime,
  };
}

describe('BackfillService requests', () => {
  it('signs an upload bound to the size and type, in its folder', async () => {
    const t = build();
    await expect(
      t.service.uploadUrl({
        room: 'Hall A',
        contentType: 'audio/webm',
        bytes: 1234,
      }),
    ).resolves.toEqual({ url: 'https://s3/put', key: KEY });
    expect(t.storage.presignUpload).toHaveBeenCalledWith({
      folder: 'caption-backfill',
      contentType: 'audio/webm',
      contentLength: 1234,
    });
  });

  it('queues one job per key, with the desk clock skew', async () => {
    const t = build();
    const deskNow = new Date(Date.now() - 90_000).toISOString();
    await expect(
      t.service.submit({
        room: ' Hall A ',
        key: KEY,
        startedAt: new Date(T0).toISOString(),
        durationMs: 60_000,
        deskNow,
      }),
    ).resolves.toEqual({ jobId: JOB_ID });
    const [, data, options] = t.queue.add.mock.calls[0] as [
      string,
      { room: string; skewMs: number },
      { jobId: string },
    ];
    expect(data.room).toBe('Hall A');
    expect(data.skewMs).toBeGreaterThanOrEqual(90_000);
    expect(data.skewMs).toBeLessThan(95_000);
    expect(options.jobId).toBe(JOB_ID);

    // the same key again is the same job, not a second pass
    t.queue.getJob.mockResolvedValue({ id: JOB_ID });
    await t.service.submit({
      room: 'Hall A',
      key: KEY,
      startedAt: new Date(T0).toISOString(),
      durationMs: 60_000,
      deskNow,
    });
    expect(t.queue.add).toHaveBeenCalledTimes(1);
  });

  it('refuses a recording that was never uploaded', async () => {
    const t = build();
    t.storage.headObject.mockResolvedValue(null);
    await expect(
      t.service.submit({
        room: 'Hall A',
        key: KEY,
        startedAt: new Date(T0).toISOString(),
        durationMs: 1,
        deskNow: new Date().toISOString(),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reports a job by state, with the counts once done', async () => {
    const t = build();
    await expect(t.service.status(JOB_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const result = { inserted: 2, skipped: 1, sessions: [] };
    t.queue.getJob.mockResolvedValue({
      getState: () => Promise.resolve('completed'),
      returnvalue: result,
    });
    await expect(t.service.status(JOB_ID)).resolves.toEqual({
      state: 'completed',
      ...result,
    });
    t.queue.getJob.mockResolvedValue({
      getState: () => Promise.resolve('delayed'),
    });
    await expect(t.service.status(JOB_ID)).resolves.toEqual({
      state: 'waiting',
    });
    t.queue.getJob.mockResolvedValue({
      getState: () => Promise.resolve('failed'),
      failedReason: 'Deepgram said no',
    });
    await expect(t.service.status(JOB_ID)).resolves.toEqual({
      state: 'failed',
      error: 'Deepgram said no',
    });
  });
});

describe('BackfillService job', () => {
  const panel = {
    id: 'panel',
    title: 'Opening panel',
    room: 'Hall A',
    startsAt: new Date(T0),
    endsAt: new Date(T0 + 60 * 60_000),
  };

  it('stores only the lines nobody captioned, at desk start + skew + offset', async () => {
    const t = build({
      sessions: [panel],
      // live captions have a line at 09:10:05
      said: [T0 + 10 * 60_000 + 5_000],
      utterances: [
        { text: 'Missed live', speaker: 0, startMs: 0, endMs: 2_000 },
        { text: 'Captioned live', speaker: 1, startMs: 4_000, endMs: 5_000 },
        { text: 'After hours', startMs: 3 * 3_600_000, endMs: 3 * 3_600_000 },
      ],
    });
    const result = await t.service.run({
      room: 'Hall A',
      key: KEY,
      // the desk's clock runs a minute slow
      startedAt: new Date(T0 + 9 * 60_000).toISOString(),
      durationMs: 3 * 3_600_000,
      skewMs: 60_000,
    });

    expect(result).toEqual({
      inserted: 1,
      skipped: 2,
      sessions: [{ id: 'panel', title: 'Opening panel', inserted: 1 }],
    });
    expect(t.saved).toEqual([
      expect.objectContaining({
        sessionId: 'panel',
        text: 'Missed live',
        language: 'en',
        backfill: true,
        offsetMs: null,
        createdAt: new Date(T0 + 10 * 60_000),
      }),
    ]);
    expect(t.transcription.transcribeUrl).toHaveBeenCalledWith(
      'https://s3/get',
      { keywords: ['Pitchathon'] },
    );
    expect(t.storage.presignRead).toHaveBeenCalledWith(KEY, 3600);
    expect(t.realtime.emitToRoom).toHaveBeenCalledWith(
      'captions:panel',
      'caption',
      expect.objectContaining({ backfill: true, text: 'Missed live' }),
    );
    // scoped to the current event
    expect(t.sessionQb.andWhere).toHaveBeenCalledWith(
      's.editionId = :editionId',
      { editionId: 'ed-1' },
    );
  });

  it('does not pay to transcribe when no session ran in the room', async () => {
    const t = build({ sessions: [] });
    await expect(
      t.service.run({
        room: 'Hall A',
        key: KEY,
        startedAt: new Date(T0).toISOString(),
        durationMs: 60_000,
        skewMs: 0,
      }),
    ).resolves.toEqual({ inserted: 0, skipped: 0, sessions: [] });
    expect(t.transcription.transcribeUrl).not.toHaveBeenCalled();
  });
});
