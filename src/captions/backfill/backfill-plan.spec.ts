import {
  BACKFILL_KEY_PATTERN,
  isCovered,
  placeLines,
  sessionAt,
} from './backfill-plan';

const T0 = Date.parse('2026-10-17T09:00:00Z');
const min = 60_000;
const session = (id: string, startMin: number, endMin: number) => ({
  id,
  startsAt: new Date(T0 + startMin * min),
  endsAt: new Date(T0 + endMin * min),
});

describe('which session a back-filled line belongs to', () => {
  const opening = session('opening', 0, 60);
  const panel = session('panel', 60, 120);

  it('is the session running at the time', () => {
    expect(sessionAt([opening, panel], T0 + 30 * min)?.id).toBe('opening');
    expect(sessionAt([opening, panel], T0 + 90 * min)?.id).toBe('panel');
  });

  it('is the latest to have started when windows overlap', () => {
    // 61 min: inside the opening's overrun and the panel itself
    expect(sessionAt([opening, panel], T0 + 61 * min)?.id).toBe('panel');
    expect(sessionAt([panel, opening], T0 + 61 * min)?.id).toBe('panel');
  });

  it('takes the lead-up and the overrun, and nothing beyond', () => {
    expect(sessionAt([opening], T0 - 14 * min)?.id).toBe('opening');
    expect(sessionAt([opening], T0 - 16 * min)).toBeNull();
    expect(sessionAt([opening], T0 + 119 * min)?.id).toBe('opening');
    expect(sessionAt([opening], T0 + 121 * min)).toBeNull();
  });

  it('gives a line before every candidate to the first about to start', () => {
    const later = session('later', 5, 30);
    expect(sessionAt([later, opening], T0 - 5 * min)?.id).toBe('opening');
  });

  it('is nobody when there are no sessions', () => {
    expect(sessionAt([], T0)).toBeNull();
  });
});

describe('a line the live captions already have', () => {
  const said = [T0, T0 + 10_000, T0 + 20_000];

  it('is covered by a stored line from 1.5s before it to 2.5s after it', () => {
    expect(isCovered(said, T0 + 11_600, T0 + 12_000)).toBe(false);
    expect(isCovered(said, T0 + 11_400, T0 + 12_000)).toBe(true); // 10.0 >= 11.4 - 1.5
    expect(isCovered(said, T0 + 5_000, T0 + 7_500)).toBe(true); // 10.0 <= 7.5 + 2.5
    expect(isCovered(said, T0 + 5_000, T0 + 7_400)).toBe(false);
    expect(isCovered(said, T0 + 21_600, T0 + 30_000)).toBe(false);
  });

  it('is never covered in an empty session', () => {
    expect(isCovered([], T0, T0 + 1_000)).toBe(false);
  });
});

describe('placing a recording on the clock', () => {
  it('adds the offset to the corrected start and counts what no session holds', () => {
    const { placed, skipped } = placeLines(
      [
        { text: 'Welcome', speaker: 0, startMs: 0, endMs: 1_200 },
        { text: 'Much later', startMs: 3 * 60 * min, endMs: 3 * 60 * min },
      ],
      [session('opening', 0, 60)],
      T0 + 10 * min,
    );
    expect(placed).toEqual([
      {
        sessionId: 'opening',
        text: 'Welcome',
        speaker: 0,
        start: T0 + 10 * min,
        end: T0 + 10 * min + 1_200,
      },
    ]);
    expect(skipped).toBe(1);
  });
});

describe('a back-fill key', () => {
  it('is a UUID in the back-fill folder and nothing else', () => {
    expect(
      BACKFILL_KEY_PATTERN.test(
        'caption-backfill/3f0c6c1e-4c0e-4f43-9d55-8b8f5a6f2a10',
      ),
    ).toBe(true);
    expect(
      BACKFILL_KEY_PATTERN.test(
        'edition-logos/3f0c6c1e-4c0e-4f43-9d55-8b8f5a6f2a10',
      ),
    ).toBe(false);
    expect(BACKFILL_KEY_PATTERN.test('caption-backfill/../secret')).toBe(false);
  });
});
