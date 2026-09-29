/**
 * Caption languages for GS-26.
 *
 * English is the transcription language and stays canonical: everything else
 * is machine translation of an English final, carries the AI-generated label,
 * and is never written back over the stored transcript.
 */
export enum CaptionLanguage {
  EN = 'en',
  HA = 'ha',
  IG = 'ig',
  YO = 'yo',
  PCM = 'pcm',
  FR = 'fr',
}

/** Every language except the source. */
export const TRANSLATION_TARGETS = [
  CaptionLanguage.HA,
  CaptionLanguage.IG,
  CaptionLanguage.YO,
  CaptionLanguage.PCM,
  CaptionLanguage.FR,
] as const;

export const LANGUAGE_NAMES: Record<CaptionLanguage, string> = {
  [CaptionLanguage.EN]: 'English',
  [CaptionLanguage.HA]: 'Hausa',
  [CaptionLanguage.IG]: 'Igbo',
  [CaptionLanguage.YO]: 'Yoruba',
  [CaptionLanguage.PCM]: 'Nigerian Pidgin',
  [CaptionLanguage.FR]: 'French',
};

/** Anything unrecognised falls back to English rather than erroring a join. */
export function toCaptionLanguage(value: unknown): CaptionLanguage {
  return Object.values(CaptionLanguage).includes(value as CaptionLanguage)
    ? (value as CaptionLanguage)
    : CaptionLanguage.EN;
}
