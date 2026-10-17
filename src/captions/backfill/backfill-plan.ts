import type { UrlUtterance } from '../transcription/transcription.interface';

/**
 * The pure half of the desk back-fill: which session each line of a desk's
 * recording belongs to, and which lines the live captions already have. Kept
 * free of the database so the rules can be tested on their own.
 */

/** Storage folder for desk recordings awaiting back-fill. */
export const BACKFILL_FOLDER = 'caption-backfill';
/** A key presignUpload made in that folder: the folder and a UUID. */
export const BACKFILL_KEY_PATTERN =
  /^caption-backfill\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A session is open to lines said up to this long before it starts... */
export const SESSION_LEAD_MS = 15 * 60_000;
/** ...and this long after it was due to end (sessions overrun). */
export const SESSION_TAIL_MS = 60 * 60_000;

/**
 * A line counts as already captioned when the session has a stored line said
 * from this long before it starts to this long after it ends. Live rows are
 * stamped when Deepgram finalised them, which is after the words were said,
 * hence the longer tail.
 */
export const COVER_BEFORE_MS = 1_500;
export const COVER_AFTER_MS = 2_500;

export interface SessionWindow {
  id: string;
  startsAt: Date;
  endsAt: Date;
}

/**
 * The session a line said at `at` (epoch ms) belongs to: of the sessions whose
 * window [start - 15 min, end + 60 min] holds it, the one that started last
 * but not after it - the session that was running. A line said in the lead-up
 * to every candidate goes to the one about to start first. Null when no
 * session's window holds it.
 */
export function sessionAt<T extends SessionWindow>(
  sessions: T[],
  at: number,
): T | null {
  const open = sessions.filter(
    (s) =>
      s.startsAt.getTime() - SESSION_LEAD_MS <= at &&
      at <= s.endsAt.getTime() + SESSION_TAIL_MS,
  );
  if (open.length === 0) return null;
  const started = open.filter((s) => s.startsAt.getTime() <= at);
  if (started.length > 0) {
    return started.reduce((a, b) =>
      b.startsAt.getTime() > a.startsAt.getTime() ? b : a,
    );
  }
  return open.reduce((a, b) =>
    b.startsAt.getTime() < a.startsAt.getTime() ? b : a,
  );
}

/**
 * Whether a stored line falls in a new line's coverage window. `said` holds
 * the stored lines' times (epoch ms), sorted ascending.
 */
export function isCovered(said: number[], start: number, end: number): boolean {
  const from = start - COVER_BEFORE_MS;
  const to = end + COVER_AFTER_MS;
  // first stored time at or after `from`
  let lo = 0;
  let hi = said.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (said[mid] < from) lo = mid + 1;
    else hi = mid;
  }
  return lo < said.length && said[lo] <= to;
}

/** A line of the recording, placed on the server's clock and in a session. */
export interface PlacedLine {
  sessionId: string;
  text: string;
  speaker?: number;
  /** Epoch ms, server clock. */
  start: number;
  end: number;
}

/**
 * Places each line on the server's clock - the desk's start time, corrected
 * by its clock skew, plus the line's offset - and in its session. Lines no
 * session holds are counted, not placed.
 */
export function placeLines(
  utterances: UrlUtterance[],
  sessions: SessionWindow[],
  recordingStart: number,
): { placed: PlacedLine[]; skipped: number } {
  const placed: PlacedLine[] = [];
  let skipped = 0;
  for (const u of utterances) {
    const start = recordingStart + u.startMs;
    const end = recordingStart + Math.max(u.endMs, u.startMs);
    const session = sessionAt(sessions, start);
    if (!session) {
      skipped += 1;
      continue;
    }
    placed.push({
      sessionId: session.id,
      text: u.text,
      speaker: u.speaker,
      start,
      end,
    });
  }
  return { placed, skipped };
}
