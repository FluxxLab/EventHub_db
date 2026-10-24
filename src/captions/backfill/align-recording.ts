/**
 * Where a stream's recording sits on the day's clock, found from its words.
 *
 * A re-caption is told when its recording started, but that time can be
 * wrong: a stream's "started" time may be when it was scheduled or published,
 * or it may be typed by hand. The live captions already hold much of what was
 * said in the room, each line with the time it was heard. Matching short runs
 * of words between the recording and the live captions gives, for each match,
 * how far the given start time is off; when most matches agree, that is the
 * correction.
 */

/** A run of this many words is distinctive enough to match on. */
const RUN = 3;
/** Matches are counted in bins this wide, ms. */
const BIN_MS = 20_000;
/** A run heard more often than this in the live captions is too common to place anything. */
const MAX_LIVE_REPEATS = 4;
/** At least this many matches must agree... */
export const MIN_MATCHES = 15;
/** ...and outnumber the next best agreement this many times over. */
const DOMINANCE = 3;

export type RecordingLine = { text: string; startMs: number; endMs: number };
export type LiveLine = { text: string; at: number };

const words = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9']+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 1);

/** The text a line would have in a comparison: lower case, plain words. */
export const plainText = (text: string) => words(text).join(' ');

/**
 * How far (ms) the recording's true start is from `guessStart`, or null when
 * the live captions do not agree on one answer. `matches` is how many runs of
 * words agreed.
 */
export function findOffset(
  recording: RecordingLine[],
  live: LiveLine[],
  guessStart: number,
): { offsetMs: number; matches: number } | null {
  // every run of words heard live, with when
  const liveRuns = new Map<string, number[]>();
  const liveWords: { w: string; at: number }[] = [];
  for (const line of [...live].sort((a, b) => a.at - b.at)) {
    for (const w of words(line.text)) liveWords.push({ w, at: line.at });
  }
  for (let i = 0; i + RUN <= liveWords.length; i++) {
    const key = liveWords
      .slice(i, i + RUN)
      .map((x) => x.w)
      .join(' ');
    const times = liveRuns.get(key) ?? [];
    times.push(liveWords[i].at);
    liveRuns.set(key, times);
  }

  // each run in the recording, placed at the guessed start, against the live times
  const deltas: number[] = [];
  for (const line of recording) {
    const ws = words(line.text);
    const span = Math.max(line.endMs - line.startMs, 0);
    for (let i = 0; i + RUN <= ws.length; i++) {
      const times = liveRuns.get(ws.slice(i, i + RUN).join(' '));
      if (!times || times.length > MAX_LIVE_REPEATS) continue;
      const at = guessStart + line.startMs + (span * i) / ws.length;
      for (const t of times) deltas.push(t - at);
    }
  }
  if (deltas.length < MIN_MATCHES) return null;

  const bins = new Map<number, number>();
  for (const d of deltas) {
    const b = Math.round(d / BIN_MS);
    bins.set(b, (bins.get(b) ?? 0) + 1);
  }
  // a bin with its neighbours, so an answer on a bin's edge is not split
  const around = (b: number) =>
    (bins.get(b - 1) ?? 0) + (bins.get(b) ?? 0) + (bins.get(b + 1) ?? 0);
  let best = 0;
  let bestCount = -1;
  for (const b of bins.keys()) {
    const c = around(b);
    if (c > bestCount) {
      best = b;
      bestCount = c;
    }
  }
  let runnerUp = 0;
  for (const b of bins.keys()) {
    if (Math.abs(b - best) > 2) runnerUp = Math.max(runnerUp, around(b));
  }
  if (bestCount < MIN_MATCHES || bestCount < runnerUp * DOMINANCE) return null;

  const agreeing = deltas
    .filter((d) => Math.abs(d - best * BIN_MS) <= 1.5 * BIN_MS)
    .sort((a, b) => a - b);
  const median = agreeing[Math.floor(agreeing.length / 2)];
  return { offsetMs: Math.round(median), matches: agreeing.length };
}
