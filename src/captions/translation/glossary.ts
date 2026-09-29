import { CaptionLanguage } from './languages';

/**
 * Native-speaker input for the translation prompt.
 *
 * Claude cannot be fine-tuned through the API, so this file is the closest
 * equivalent: verified examples and agreed terminology, injected into the
 * cached system prompt. Because that prompt sits behind a cache breakpoint it
 * costs roughly a tenth of normal input tokens on every call after the first,
 * so there is no meaningful per-caption cost to filling this in generously.
 *
 * Everything here starts empty on purpose. A guessed Yoruba or Pidgin line
 * would anchor the model harder than no example at all, so blanks are omitted
 * from the prompt rather than shipped half-filled.
 */

type Rendering = Partial<
  Record<Exclude<CaptionLanguage, CaptionLanguage.EN>, string>
>;

export interface GlossaryTerm {
  /** The English phrase as a speaker would actually say it. */
  en: string;
  /** The agreed rendering per language. Leave blank until verified. */
  say: Rendering;
  /**
   * Which sense is meant, where the English is ambiguous. Read by whoever
   * fills the entry, and passed to the model so it picks the right reading
   * even before a translation is supplied.
   */
  note?: string;
}

export interface WorkedExample {
  en: string;
  say: Rendering;
}

/** Terms that must survive untranslated - the same list Deepgram gets as keyterms. */
export const DO_NOT_TRANSLATE = [
  'Pitchathon',
  'GBV',
  'GS-26',
  'VAPP Act',
  'CEDAW',
  'SDGs',
];

/**
 * Recurring summit vocabulary. This is where machine translation of this
 * subject matter most reliably goes wrong: it produces a literal calque where
 * each language has an established term.
 *
 * Fill `say` with a native speaker. Partly-filled entries are fine - only the
 * languages actually provided are sent.
 */
export const GLOSSARY: GlossaryTerm[] = [
  // Core / plenary
  { en: 'gender equality', say: {} },
  {
    en: 'gender equity',
    say: {},
    note: 'distinct from equality: fairness of process, not sameness of outcome',
  },
  { en: 'gender mainstreaming', say: {} },
  { en: 'social inclusion', say: {} },
  { en: "women's empowerment", say: {} },
  { en: 'affirmative action', say: {} },
  {
    en: 'commitment',
    say: {},
    note: 'a public pledge to act, not an emotional attachment',
  },
  { en: 'accountability', say: {} },
  { en: 'advocacy', say: {} },
  { en: 'stakeholder', say: {} },
  { en: 'grassroots', say: {} },
  {
    en: 'the last mile',
    say: {},
    note: 'reaching the hardest-to-reach communities, not a distance',
  },
  { en: 'civil society', say: {} },
  {
    en: 'implementation gap',
    say: {},
    note: 'the distance between policy on paper and practice',
  },
  { en: 'disaggregated data', say: {} },
  { en: 'evidence-based policy', say: {} },

  // Gender-based violence
  { en: 'gender-based violence', say: {} },
  { en: 'domestic violence', say: {} },
  { en: 'sexual harassment', say: {} },
  {
    en: 'survivor',
    say: {},
    note: "preferred over 'victim' throughout - keep that distinction",
  },
  { en: 'female genital mutilation', say: {} },
  { en: 'child marriage', say: {} },
  { en: 'harmful traditional practices', say: {} },
  {
    en: 'safeguarding',
    say: {},
    note: 'organisational duty of protection, not general safety',
  },
  {
    en: 'referral pathway',
    say: {},
    note: 'the route a survivor takes between services',
  },
  { en: 'consent', say: {} },
  {
    en: 'shelter',
    say: {},
    note: 'a refuge for survivors, not housing generally',
  },

  // Health
  { en: 'maternal health', say: {} },
  { en: 'maternal mortality', say: {} },
  { en: 'sexual and reproductive health and rights', say: {} },
  { en: 'family planning', say: {} },
  { en: 'antenatal care', say: {} },
  { en: 'skilled birth attendant', say: {} },
  { en: 'obstetric fistula', say: {} },
  { en: 'primary health care', say: {} },
  { en: 'immunisation', say: {} },

  // Economic
  { en: "women's economic empowerment", say: {} },
  { en: 'financial inclusion', say: {} },
  { en: 'access to credit', say: {} },
  { en: 'land rights', say: {} },
  {
    en: 'cooperative',
    say: {},
    note: 'a member-owned savings or trading group',
  },
  { en: 'market women', say: {} },
  { en: 'informal sector', say: {} },
  { en: 'unpaid care work', say: {} },
  { en: 'livelihood', say: {} },
  { en: 'value chain', say: {} },
  { en: 'microfinance', say: {} },
  { en: 'women-owned business', say: {} },

  // Digital / innovation
  { en: 'digital divide', say: {} },
  { en: 'digital literacy', say: {} },
  { en: 'online gender-based violence', say: {} },
  { en: 'data privacy', say: {} },
  { en: 'assistive technology', say: {} },
  { en: 'innovation ecosystem', say: {} },

  // Youth / education
  { en: 'out-of-school children', say: {} },
  { en: 'girl child education', say: {} },
  {
    en: 'enrolment and retention',
    say: {},
    note: 'staying in school, not just starting',
  },
  { en: 'mentorship', say: {} },
  { en: 'youth participation', say: {} },
  { en: 'skills acquisition', say: {} },

  // Disability
  { en: 'disability inclusion', say: {} },
  {
    en: 'persons with disabilities',
    say: {},
    note: 'person-first phrasing - preserve it',
  },
  { en: 'accessibility', say: {} },
  { en: 'reasonable accommodation', say: {} },
];

/**
 * Whole-sentence examples in the register of the summit. Ten good ones move
 * quality more than any parameter available here - especially for Pidgin,
 * where the failure mode is output that reads as lightly-accented English.
 *
 * Pick real fragments from a captured session so the register is authentic,
 * including ones that start or end mid-sentence.
 */
export const WORKED_EXAMPLES: WorkedExample[] = [];

const LANGUAGE_LABEL: Record<string, string> = {
  [CaptionLanguage.HA]: 'Hausa',
  [CaptionLanguage.IG]: 'Igbo',
  [CaptionLanguage.YO]: 'Yoruba',
  [CaptionLanguage.PCM]: 'Nigerian Pidgin',
};

function renderings(say: Rendering): string[] {
  return Object.entries(say)
    .filter(([, value]) => value && value.trim().length > 0)
    .map(([code, value]) => `    ${LANGUAGE_LABEL[code] ?? code}: ${value}`);
}

/** Prompt lines for the glossary, or nothing while it is unfilled. */
export function glossaryLines(): string[] {
  const filled = GLOSSARY.map((t) => ({
    term: t,
    lines: renderings(t.say),
  })).filter((t) => t.lines.length > 0);
  if (filled.length === 0) return [];

  return [
    '',
    'Agreed terminology. Use these renderings rather than translating literally:',
    ...filled.flatMap(({ term, lines }) => [
      `  "${term.en}"${term.note ? ` (${term.note})` : ''}`,
      ...lines,
    ]),
  ];
}

/** Prompt lines for the worked examples, or nothing while there are none. */
export function exampleLines(): string[] {
  const filled = WORKED_EXAMPLES.map((e) => ({
    ex: e,
    lines: renderings(e.say),
  })).filter((e) => e.lines.length > 0);
  if (filled.length === 0) return [];

  return [
    '',
    'Worked examples, verified by native speakers. Match this register:',
    ...filled.flatMap(({ ex, lines }) => [`  English: ${ex.en}`, ...lines]),
  ];
}
