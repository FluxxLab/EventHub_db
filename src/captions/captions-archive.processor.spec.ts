import type { Job } from 'bullmq';
import {
  archiveRows,
  CaptionsArchiveProcessor,
  type ArchiveJob,
} from './captions-archive.processor';

jest.mock('node:fs/promises', () => ({
  unlink: jest.fn().mockResolvedValue(undefined),
}));

const START = '2026-10-17T09:00:00.000Z';
const T0 = Date.parse(START);

describe('the rows an archive pass writes', () => {
  const utterances = [
    { text: 'Good morning', speaker: 0, offsetMs: 0, endMs: 1_000 },
    {
      text: 'Back-filled already',
      speaker: 1,
      offsetMs: 10_000,
      endMs: 11_000,
    },
  ];

  it('stamps each line with when it was said, and drops what a desk back-filled', () => {
    const rows = archiveRows(
      { sessionId: 's1', room: 'Hall A', startedAt: START },
      utterances,
      [T0 + 10_200],
    );
    expect(rows).toEqual([
      {
        sessionId: 's1',
        room: 'Hall A',
        text: 'Good morning',
        speaker: 0,
        offsetMs: null,
        createdAt: new Date(T0),
      },
    ]);
  });

  it('keeps offsets, as before, for a job without the recording start', () => {
    const rows = archiveRows({ sessionId: 's1', room: 'Hall A' }, utterances, [
      T0 + 10_200,
    ]);
    expect(rows.map((r) => [r.offsetMs, r.createdAt])).toEqual([
      [0, undefined],
      [10_000, undefined],
    ]);
  });
});

describe('CaptionsArchiveProcessor', () => {
  it('replaces the live rows but keeps the back-filled ones', async () => {
    const manager = {
      delete: jest.fn().mockResolvedValue({}),
      find: jest
        .fn()
        .mockResolvedValue([
          { createdAt: new Date(T0 + 10_200), offsetMs: null },
        ]),
      insert: jest.fn().mockResolvedValue({}),
    };
    const segments = {
      manager: {
        transaction: (fn: (m: typeof manager) => Promise<void>) => fn(manager),
      },
    };
    const transcription = {
      openStream: jest.fn(),
      archive: jest.fn().mockResolvedValue([
        { text: 'Good morning', offsetMs: 0, endMs: 1_000 },
        { text: 'Back-filled already', offsetMs: 10_000, endMs: 11_000 },
      ]),
    };
    const processor = new CaptionsArchiveProcessor(
      segments as never,
      transcription,
    );

    await processor.process({
      data: {
        sessionId: 's1',
        room: 'Hall A',
        path: '/tmp/x.wav',
        startedAt: START,
      },
    } as Job<ArchiveJob>);

    expect(manager.delete).toHaveBeenCalledWith(expect.anything(), {
      sessionId: 's1',
      backfill: false,
    });
    expect(manager.find).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        where: { sessionId: 's1', language: 'en', backfill: true },
      }),
    );
    const [[, inserted]] = manager.insert.mock.calls as [
      unknown,
      { text: string }[],
    ][];
    expect(inserted.map((r) => r.text)).toEqual(['Good morning']);
  });
});
