/**
 * The words a session's captions listen for (Deepgram key terms): the event's
 * name, the speakers on stage and their organisations, and the event's own
 * vocabulary (Captions > Vocabulary): acronyms, programme names, places,
 * phrases like "full product" that would otherwise be heard as common words.
 *
 * Names matter most: speech recognition gets them wrong more than anything
 * else, and the session's speakers are known before a word is said.
 */

/** Always listened for, whatever the event. */
export const BASE_TERMS = ['GBV', 'Pitchathon'];

/** Deepgram takes about this many key terms per stream; the rest would be refused. */
export const MAX_TERMS = 100;
/** Longer than this is a sentence, not a term. */
export const MAX_TERM_LENGTH = 60;

export function captionTerms(input: {
  event?: { name?: string | null; shortName?: string | null } | null;
  /** Organisers' own list, first among the extras. */
  vocabulary?: string[] | null;
  speakers?: { name?: string | null; organisation?: string | null }[] | null;
}): string[] {
  const seen = new Map<string, string>();
  const add = (term: string | null | undefined) => {
    const t = term?.replace(/\s+/g, ' ').trim();
    if (!t || t.length > MAX_TERM_LENGTH) return;
    const key = t.toLowerCase();
    if (!seen.has(key)) seen.set(key, t);
  };
  // the organisers' words first: if the list is cut, theirs survive
  for (const t of input.vocabulary ?? []) add(t);
  add(input.event?.name);
  add(input.event?.shortName);
  for (const s of input.speakers ?? []) {
    add(s.name);
    add(s.organisation);
  }
  for (const t of BASE_TERMS) add(t);
  return [...seen.values()].slice(0, MAX_TERMS);
}
