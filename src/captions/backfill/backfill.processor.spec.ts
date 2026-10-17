import { UnrecoverableError, type Job } from 'bullmq';
import { BackfillProcessor } from './backfill.processor';
import type { BackfillJob } from './backfill.service';

const job = (attemptsMade: number, attempts = 3) =>
  ({
    data: { key: 'caption-backfill/k' },
    attemptsMade,
    opts: { attempts },
  }) as unknown as Job<BackfillJob>;

describe('BackfillProcessor', () => {
  const build = (run: jest.Mock) => {
    const backfill = { run, discard: jest.fn().mockResolvedValue(undefined) };
    return { backfill, processor: new BackfillProcessor(backfill as never) };
  };

  it('deletes the upload once the job is done', async () => {
    const result = { inserted: 1, skipped: 0, sessions: [] };
    const t = build(jest.fn().mockResolvedValue(result));
    await expect(t.processor.process(job(0))).resolves.toBe(result);
    expect(t.backfill.discard).toHaveBeenCalledWith('caption-backfill/k');
  });

  it('keeps it for a retry, and deletes it after the last attempt', async () => {
    const t = build(jest.fn().mockRejectedValue(new Error('timeout')));
    await expect(t.processor.process(job(0))).rejects.toThrow('timeout');
    expect(t.backfill.discard).not.toHaveBeenCalled();
    await expect(t.processor.process(job(2))).rejects.toThrow('timeout');
    expect(t.backfill.discard).toHaveBeenCalledTimes(1);
  });

  it('deletes it straight away when retrying cannot help', async () => {
    const t = build(
      jest.fn().mockRejectedValue(new UnrecoverableError('not configured')),
    );
    await expect(t.processor.process(job(0))).rejects.toThrow();
    expect(t.backfill.discard).toHaveBeenCalledTimes(1);
  });
});
