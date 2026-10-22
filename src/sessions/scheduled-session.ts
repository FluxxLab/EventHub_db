/** A session may start this early by the programme and still be the one on. */
export const SCHEDULE_EARLY_MS = 10 * 60_000;
/** And run over by this long before its room counts as empty. */
export const SCHEDULE_OVERRUN_MS = 20 * 60_000;

/**
 * The session the programme has in a room now, from those near the time:
 * one on now (the latest-starting, when they nest), else the next about to
 * start, else the last one running over. Null when nothing is near.
 */
export function pickScheduled<T extends { startsAt: Date; endsAt: Date }>(
  sessions: T[],
  now: Date,
): T | null {
  const t = now.getTime();
  const start = (s: T) => new Date(s.startsAt).getTime();
  const end = (s: T) => new Date(s.endsAt).getTime();
  const on = sessions
    .filter((s) => start(s) <= t && end(s) > t)
    .sort((a, b) => start(b) - start(a));
  if (on[0]) return on[0];
  const soon = sessions
    .filter((s) => start(s) > t && start(s) - t <= SCHEDULE_EARLY_MS)
    .sort((a, b) => start(a) - start(b));
  if (soon[0]) return soon[0];
  const over = sessions
    .filter((s) => end(s) <= t && t - end(s) <= SCHEDULE_OVERRUN_MS)
    .sort((a, b) => end(b) - end(a));
  return over[0] ?? null;
}
