/**
 * Masks profanity in caption text on its way out to a screen.
 *
 * The second of two passes. Deepgram's own `profanity_filter` runs first, at
 * transcription time, and handles most English; this one exists because that
 * list is English-only and knows nothing of Nigerian Pidgin, Hausa, Igbo or
 * Yoruba - and every translation is generated after Deepgram has finished, so
 * nothing upstream has ever looked at it.
 *
 * Applied at emit and on the catch-up response, not before the row is written:
 * the stored English is already masked by Deepgram, and masking a second time
 * on the way into the database would only remove words from the record that
 * the translator still needs to see to produce a faithful sentence.
 *
 * Two things this deliberately does not attempt:
 *
 * - Leetspeak, spacing and other evasion. Live captions are a transcription of
 *   speech, not user input; there is nobody on the other end trying to smuggle
 *   a word past a regex, and the patterns needed to catch that are the ones
 *   that produce false positives on ordinary words.
 * - Slurs used as testimony. A GBV session may quote abuse verbatim, and this
 *   masks it like anything else. That is a known cost of running the filter
 *   with no per-session control.
 */

/**
 * Word stems, matched on a word boundary and case-insensitively.
 *
 * This is the part meant to be edited. Keep entries to the stem - the pattern
 * allows common suffixes - and prefer leaving a borderline word out: a false
 * positive silently deletes something a speaker actually said, in front of the
 * room, and nobody watching can tell it happened.
 */
const TERMS = [
  // English
  'fuck',
  'shit',
  'bitch',
  'bastard',
  'cunt',
  'dick',
  'piss',
  'whore',
  'slut',
  'wanker',
  'prick',
  'arsehole',
  'asshole',
  'motherfucker',
  'bollocks',
  'twat',
  // Nigerian Pidgin and common local coinages Deepgram's list does not carry
  'olodo',
  'mumu',
  'ashawo',
  'werey',
  'oloshi',
  'iranu',
  'shege',
  'dan iska',
  'ode',
] as const;

/**
 * One alternation, built once. Word boundaries on both sides so "assassinate"
 * and "Scunthorpe" survive; a trailing suffix group catches plurals and the
 * -ing/-ed/-er forms without letting the stem match inside a longer unrelated
 * word.
 */
const PATTERN = new RegExp(
  `\\b(${TERMS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(
    '|',
  )})(s|es|ed|ing|er|ers)?\\b`,
  'gi',
);

/**
 * Replaces each match with asterisks of the same length.
 *
 * Same length rather than a fixed token so the line keeps its shape - a caption
 * that visibly loses a word reads as censored, which is honest, where a silent
 * deletion reads as a transcription failure.
 */
export function maskProfanity(text: string): string {
  if (!text) return text;
  return text.replace(PATTERN, (match) => '*'.repeat(match.length));
}
