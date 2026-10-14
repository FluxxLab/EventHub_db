import type { Session } from './entities/session.entity';

/**
 * Who is on each of a session's mics, by mic number: the speaker's name when
 * one of the session's speakers holds it, else the mic's own label
 * ("Audience", a guest typed in). Mics nobody named are left out.
 *
 * Looked up when a line is shown, never stored on the line, so a mic named
 * late or corrected after the session renames everything already said on it.
 */
export function micNames(
  session: Pick<Session, 'mics' | 'speakers'>,
): Map<number, string> {
  const names = new Map<number, string>();
  for (const m of session.mics ?? []) {
    const speaker = m.speakerId
      ? session.speakers?.find((s) => s.id === m.speakerId)
      : undefined;
    const name = speaker?.name ?? m.label;
    if (name) names.set(m.mic, name);
  }
  return names;
}
