import type { CallToActionType } from '../entities/call-to-action.entity';

export const ANALYSIS_PROVIDER = Symbol('ANALYSIS_PROVIDER');

/** One transcript line as the analysis reads it: numbered, timed and named. */
export interface AnalysisLine {
  /** 1-based, so the model can point back at the line it quotes. */
  n: number;
  at: Date;
  /** The name on the mic, "Mic 2", "Speaker 1", or null. */
  who: string | null;
  text: string;
}

export interface AnalysisContext {
  event: string;
  session: string;
  /** The session's speakers, "Name (Organisation)". */
  speakers: string[];
  /** Who calls to action may be directed at: the event's agencies and the usual groups. */
  targets: string[];
  /** What is already recorded for the session, so it is not suggested again. */
  alreadyRecorded: string[];
  /** The organisers' brief: what the session was asked to address. Context, never a source of calls. */
  brief?: string | null;
}

/** A call to action as the model finds it, before it is checked and saved. */
export interface FoundCallToAction {
  type: CallToActionType;
  action: string;
  shortText: string;
  directedAt: string;
  proposedBy: string | null;
  proposedByOrganisation: string | null;
  deadline: string | null;
  amount: string | null;
  theme: string | null;
  quote: string;
  /** The line the quote is on. */
  line: number;
  needsDetail: boolean;
}

/**
 * Reads a stretch of transcript and finds its calls to action. Behind an
 * interface so the model (Gemini today) can be swapped by configuration.
 */
export interface AnalysisProvider {
  /** False when no key is set: Analyse then says so instead of failing. */
  readonly configured: boolean;
  find(
    lines: AnalysisLine[],
    context: AnalysisContext,
  ): Promise<FoundCallToAction[]>;
  /** Who said each call (by ref), read from the transcript; only grounded names. */
  whoSaid?(
    session: string,
    speakers: string[],
    lines: AnalysisLine[],
    items: { ref: string; line: number; quote: string }[],
  ): Promise<Map<string, { name: string; organisation: string | null }>>;
}
