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

/** A long recording is matched in pieces this long, so a break in the stream does not throw the rest off. */
export const PIECE_MS = 20 * 60_000;
/** A piece further than this from the others' answer is taken to be a wrong match, not a break. */
const MAX_DRIFT_MS = 90 * 60_000;

export type PiecewiseOffset = {
  /** How far each piece of the recording is from the given start, ms, by piece index. */
  offsets: number[];
  /** How many pieces were matched in the live captions (the rest borrow a neighbour's). */
  matched: number;
  /** All the pieces' answers agreeing would mean the stream ran without a break. */
  pieces: number;
};

/**
 * Like findOffset, piece by piece. A live stream that dropped and resumed
 * leaves a recording that skips the time it was down, so a single start puts
 * everything after the drop too early. Each piece is matched on its own; a
 * piece with too little to match (a break, music) takes the answer of the
 * nearest matched piece before it, or after it at the start. Null when no
 * piece matches.
 */
export function findPiecewiseOffset(
  recording: RecordingLine[],
  live: LiveLine[],
  guessStart: number,
  pieceMs = PIECE_MS,
): PiecewiseOffset | null {
  if (recording.length === 0) return null;
  const last = Math.max(...recording.map((l) => l.startMs));
  const pieces = Math.floor(last / pieceMs) + 1;
  const groups: RecordingLine[][] = Array.from({ length: pieces }, () => []);
  for (const line of recording) {
    groups[Math.floor(line.startMs / pieceMs)].push(line);
  }
  const found = groups.map((g) =>
    g.length ? (findOffset(g, live, guessStart)?.offsetMs ?? null) : null,
  );
  // a piece far from what most pieces say matched something else said that day
  const sorted = found
    .filter((x): x is number => x !== null)
    .sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  for (let i = 0; i < found.length; i++) {
    const x = found[i];
    if (x !== null && Math.abs(x - median) > MAX_DRIFT_MS) found[i] = null;
  }
  const matched = found.filter((x) => x !== null).length;
  if (matched === 0) return null;
  const offsets: number[] = [];
  let prev: number | null = null;
  for (let i = 0; i < pieces; i++) {
    if (found[i] !== null) prev = found[i];
    offsets.push(prev ?? (found.find((x) => x !== null) as number));
  }
  return { offsets, matched, pieces };
}

/** The offset that applies at a point in the recording. */
export const offsetAt = (p: PiecewiseOffset, ms: number, pieceMs = PIECE_MS) =>
  p.offsets[Math.min(Math.floor(ms / pieceMs), p.offsets.length - 1)];
