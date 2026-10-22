import type { AgendaFix } from '../../captions/agenda-check/agenda-check';

/**
 * The day's wrap-up, run by the server overnight: the captions checked
 * against the agenda (sure mix-ups moved, the rest kept for a person), voices
 * named, sessions analysed, and each call's speaker found. What it did waits
 * for the console in the morning.
 */

/** Moved without asking only when the AI is this sure and names where the lines go. */
export const AUTO_MOVE_CONFIDENCE = 0.9;

export type NightlyResult = {
  editionId: string;
  day: number;
  /** Lagos date it ran for, YYYY-MM-DD. */
  date: string;
  startedAt: string;
  finishedAt: string | null;
  moved: (AgendaFix & { movedLines: number })[];
  toReview: (AgendaFix & { why: string })[];
  roomsChecked: number;
  roomsFailed: string[];
  namesAdded: number;
  analysed: number;
  newSuggestions: number;
  speakersFilled: number;
  failures: number;
};

const LAGOS_MS = 60 * 60_000;

/** "2026-10-22" and minutes past midnight, in Abuja (WAT, UTC+1). */
export function lagosClock(now: Date): { date: string; minutes: number } {
  const t = new Date(now.getTime() + LAGOS_MS);
  return {
    date: t.toISOString().slice(0, 10),
    minutes: t.getUTCHours() * 60 + t.getUTCMinutes(),
  };
}

/** "23:00" as minutes past midnight; the default when unreadable. */
export function minutesOf(
  hhmm: string | undefined,
  fallback = 23 * 60,
): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm?.trim() ?? '');
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return fallback;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Which findings go ahead on their own: sure, with a target. */
export function splitFixes(fixes: AgendaFix[], min = AUTO_MOVE_CONFIDENCE) {
  const auto: AgendaFix[] = [];
  const review: (AgendaFix & { why: string })[] = [];
  for (const f of fixes) {
    if (!f.toSessionId)
      review.push({
        ...f,
        why: 'It belongs to no session (a break or housekeeping).',
      });
    else if (f.confidence < min)
      review.push({
        ...f,
        why: `The AI is ${Math.round(f.confidence * 100)}% sure; check before moving.`,
      });
    else auto.push(f);
  }
  return { auto, review };
}
