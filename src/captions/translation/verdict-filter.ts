import type { Translations } from './translation.interface';

/**
 * Drops "translations" that are actually the model's verdict on its input.
 *
 * Given a garbled fragment the translator sometimes writes the target-language
 * equivalent of "this is nonsense" instead of translating - and that lands in
 * the caption panel looking exactly like something the speaker said. A
 * delegate reading Hausa has no way to tell the two apart, which makes this
 * worse than a merely bad translation.
 *
 * Two rounds of prompt work did not stop it, so it is enforced here instead.
 * The prompt is still the first line of defence; this is the one that holds.
 *
 * The check is deliberately narrow. A verdict phrase is only treated as a
 * verdict when the English source contains no such word itself - a speaker who
 * actually says "this is nonsense" must still be translated faithfully. That
 * single condition removes almost all of the false-positive risk.
 *
 * When a line is dropped nothing is shown for that language and the next
 * caption carries on. Silence is recoverable; fabricated speech is not.
 */

/** Verdict words per language: nonsense, meaningless, unclear, untranslatable. */
const VERDICT_PATTERNS: RegExp[] = [
  // English (the model sometimes answers in English regardless of the field)
  /\b(nonsense|gibberish|meaningless|unintelligible|untranslatable|garbled|incoherent)\b/,
  /\b(cannot|can not|can't|unable to) (be )?(translate|understand|make sense)/,
  /\b(no|not) (meaning|sense|clear|translatable)\b/,
  /\b(this|it) (is|seems) (unclear|not clear|an error)\b/,
  // Hausa - banza = worthless/nonsense; ma'ana = meaning
  /\bbanza\b/,
  /\b(maras|ba shi da|babu) ma'?ana\b/,
  /\bba a fahimta\b/,
  // Nigerian Pidgin - yeye = nonsense
  /\byeye\b/,
  /\bna (rubbish|nonsense)\b/,
  /\b(e|i) no (make sense|clear|gree)\b/,
  // Igbo - nzuzu = foolishness; enweghi isi = has no head/sense
  /\bnzuzu\b/,
  /\benwegh[iị] (isi|nkowa|ihe)\b/,
  // Yoruba - asan = vain/worthless; ko ni itumo = has no meaning
  /\b(oro )?asan\b/,
  /\bko ni itumo\b/,
  /\bko ye\b/,
];

/** The same notions in the source, so genuine speech about nonsense survives. */
const SOURCE_ALLOWS =
  /\b(nonsense|gibberish|meaningless|unintelligible|garbled|incoherent|rubbish|unclear|no sense|worthless|foolish)\b/;

/**
 * Diacritics are stripped before matching: the model writes proper Yoruba and
 * Igbo orthography, and "ọ̀rọ̀ asán" must match the same rule as "oro asan".
 */
const normalise = (text: string): string =>
  text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[‘’]/g, "'");

export function isVerdict(source: string, translated: string): boolean {
  // The speaker said it, so translating it is correct.
  if (SOURCE_ALLOWS.test(normalise(source))) return false;

  const candidate = normalise(translated);
  return VERDICT_PATTERNS.some((pattern) => pattern.test(candidate));
}

/**
 * Returns the translations worth showing, plus the languages dropped so the
 * caller can log them. A dropped language is simply absent - callers already
 * skip empty values.
 */
export function dropVerdicts(
  source: string,
  translations: Translations,
): { kept: Translations; dropped: string[] } {
  const kept: Translations = {};
  const dropped: string[] = [];

  for (const [language, text] of Object.entries(translations)) {
    if (!text) continue;
    if (isVerdict(source, text)) {
      dropped.push(language);
      continue;
    }
    kept[language as keyof Translations] = text;
  }

  return { kept, dropped };
}
