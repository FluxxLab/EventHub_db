import type { SpeakerNaming } from '../../editions/entities/edition.entity';
import type {
  SpeakerNameKind,
  SpeakerNameSource,
  SpeakerNameStatus,
} from './speaker-name.entity';

/**
 * The pure half of speaker naming: which caption lines might be an
 * introduction, who a line is attributed to, where a binding starts, when a
 * pending introduction is claimed by the next voice, and how a review's
 * findings are applied. Kept free of the database and the model so the
 * rules can be tested on their own.
 */

/** A session's lines are open to a name this long before it starts. */
export const SESSION_LEAD_MS = 15 * 60_000;
/** The introduction job waits this long so the lines after it exist. */
export const INTRO_DELAY_MS = 6_000;
/** "Please welcome X": X has this long to start speaking. */
export const INTRO_WINDOW_MS = 90_000;
/** A mic silent this long has probably changed hands. */
export const MIC_GAP_MS = 3 * 60_000;
/** The model's answers below this are ignored. */
export const MIN_CONFIDENCE = 0.6;
/** Lines either side of a candidate shown to the model. */
export const CONTEXT_LINES = 3;
/** A review reads the session this many lines at a time. */
export const REVIEW_CHUNK_LINES = 6000;

/**
 * Lines worth asking the model about. Generous on purpose: a false positive
 * costs one queued job, a miss costs a speaker their name. Self-introductions
 * need a title or a capitalised word after the opener, which keeps "I'm sure"
 * and "this is important" out while "I'm Dr Okafor" and "This is Amina" stay.
 */
const TITLE = String.raw`(?:dr|prof(?:essor)?|mr|mrs|ms|miss|hon(?:ourable)?|chief|alhaji|hajiya|barrister|senator|engr|engineer|pastor|rev(?:erend)?|sir|dame|madam|ambassador|comrade)\.?\s`;
const NAMED = `(?:${TITLE}|[A-Z])`;
const SELF_PATTERNS: RegExp[] = [
  /\bmy name(?:'s| is)\b/i,
  // the openers in either case, the name (or title) capitalised: no `i` flag
  new RegExp(String.raw`\b(?:[Ii] am|[Ii]'m)\s+${NAMED}`),
  new RegExp(String.raw`\b[Tt]his is\s+${NAMED}`),
  new RegExp(String.raw`\bspeaking\b.*\b(?:from|on behalf of|for)\b`, 'i'),
  new RegExp(
    String.raw`\b(?:[Hh]ere|[Ss]peaking|[Cc]oming to you)\s+from the\s+${NAMED}`,
  ),
  /\bon behalf of\b/i,
  /\brepresenting\b/i,
  /\bi (?:work|am|'m) (?:with|for|at) the\b/i,
];
const THIRD_PARTY_PATTERNS: RegExp[] = [
  /\bwelcome\b/i,
  /\bjoining us\b/i,
  /\bover to\b/i,
  /\bgive it up\b/i,
  /\bintroduc/i,
  /\bnext speaker\b/i,
  /\bhand (?:it |things )?over\b/i,
  /\bhanding over\b/i,
  /\binvite\b/i,
  /\bthe floor is yours\b/i,
  /\bround of applause\b/i,
  /\bput your hands together\b/i,
  /\bcall (?:up|upon|on)\b/i,
];

/** Whether a line reads like someone introducing themselves or the next speaker. */
export function introductionCandidate(text: string): boolean {
  const line = text.trim();
  if (line.length < 8) return false;
  return (
    SELF_PATTERNS.some((p) => p.test(line)) ||
    THIRD_PARTY_PATTERNS.some((p) => p.test(line))
  );
}

/**
 * What a heard name becomes under the event's setting: applied on its own
 * when it is a programmed speaker, suggested to an operator when the event
 * names everyone, else nothing.
 */
export function statusFor(
  setting: ReviewNaming,
  matchedProgramme: boolean,
): 'auto' | 'suggested' | null {
  // a finished session reviewed on request: every name heard is applied
  if (setting === 'finished') return 'auto';
  if (setting === 'off') return null;
  if (matchedProgramme) return 'auto';
  return setting === 'everyone' ? 'suggested' : null;
}

/**
 * The event's naming setting, or `finished`: an organiser asked for a
 * finished session to be named, which is not live captioning, so the live
 * switch does not apply and every name heard in an introduction is used.
 */
export type ReviewNaming = SpeakerNaming | 'finished';

export interface Binding {
  kind: SpeakerNameKind;
  key: number;
  name: string;
  organisation: string | null;
  status: SpeakerNameStatus;
  fromAt: Date;
  toAt: Date | null;
}

/** Only these name lines; a suggestion waits for an operator. */
export const isApplied = (b: Pick<Binding, 'status'>): boolean =>
  b.status === 'auto' || b.status === 'confirmed';

/** A line as the rules see it: its voice or mic, and when it was said (epoch ms). */
export interface LineRef {
  speaker: number | null;
  mic: number | null;
  at: number;
  backfill?: boolean;
}

/** What a line is attributed by: its mic when the room has them, else its voice. */
export function lineKey(
  line: Pick<LineRef, 'speaker' | 'mic'>,
): { kind: SpeakerNameKind; key: number } | null {
  if (line.mic !== null && line.mic !== undefined)
    return { kind: 'mic', key: line.mic };
  if (line.speaker !== null && line.speaker !== undefined)
    return { kind: 'speaker', key: line.speaker };
  return null;
}

/** Whether a binding names a line of this kind/key said at `at`. */
export function bindingCovers(
  b: Pick<Binding, 'kind' | 'key' | 'fromAt' | 'toAt'>,
  kind: SpeakerNameKind,
  key: number,
  at: number,
): boolean {
  return (
    b.kind === kind &&
    b.key === key &&
    b.fromAt.getTime() <= at &&
    (b.toAt === null || at < b.toAt.getTime())
  );
}

/**
 * The applied binding naming a line, if any: the latest-starting one that
 * covers it. A back-filled row's voice index came from its own diarisation,
 * so no 'speaker' binding names it.
 */
export function appliedBindingFor<T extends Binding>(
  bindings: readonly T[],
  line: LineRef,
): T | null {
  const k = lineKey(line);
  if (!k) return null;
  if (k.kind === 'speaker' && line.backfill) return null;
  let best: T | null = null;
  for (const b of bindings) {
    if (!isApplied(b) || !bindingCovers(b, k.kind, k.key, line.at)) continue;
    if (!best || b.fromAt.getTime() > best.fromAt.getTime()) best = b;
  }
  return best;
}

export interface Attribution {
  name: string | null;
  organisation: string | null;
}

/**
 * Who said a line: the operator's mic label when the line's mic has one,
 * else the applied binding for its mic or voice, else nobody.
 */
export function attribute(
  line: LineRef,
  micLabel: Attribution | null | undefined,
  bindings: readonly Binding[],
): Attribution {
  if (micLabel?.name) return micLabel;
  const b = appliedBindingFor(bindings, line);
  return b
    ? { name: b.name, organisation: b.organisation }
    : { name: null, organisation: null };
}

/**
 * Where a self-introduction's binding starts. A voice index holds for the
 * whole current run of the stream, so the binding names everything the
 * voice said since it opened (or since just before the session, if earlier
 * lines exist). A mic holds whoever has had it since its last binding ended.
 * Never after the line itself.
 */
export function selfBindingStart(
  kind: SpeakerNameKind,
  opts: {
    at: number;
    runStartedAt: number | null;
    sessionStartsAt: number;
    /** First line on the mic since its previous binding ended, if known. */
    firstLineOnMicAt: number | null;
  },
): number {
  const lead = opts.sessionStartsAt - SESSION_LEAD_MS;
  const start =
    kind === 'speaker'
      ? Math.max(opts.runStartedAt ?? lead, lead)
      : (opts.firstLineOnMicAt ?? lead);
  return Math.min(start, opts.at);
}

/** "Please welcome X", waiting for X to start speaking. */
export interface PendingIntro {
  name: string;
  organisation: string | null;
  speakerId: string | null;
  status: 'auto' | 'suggested';
  evidence: string;
  introducerKind: SpeakerNameKind;
  introducerKey: number;
  /** Voice indexes heard in this run before the introduction: not the newcomer. */
  seenBefore: number[];
  /** Epoch ms after which the introduction is forgotten. */
  until: number;
}

/**
 * Whether a line is the introduced person's first. Not the introducer's own
 * key; nothing applied already names it; and for a voice, one not heard in
 * this run before the introduction (a mic only has to be a different one).
 */
export function claimsIntroduction(
  pending: PendingIntro,
  line: LineRef,
  alreadyNamed: boolean,
): boolean {
  if (line.at > pending.until) return false;
  const k = lineKey(line);
  if (!k || alreadyNamed) return false;
  if (k.kind === pending.introducerKind && k.key === pending.introducerKey)
    return false;
  if (k.kind === 'speaker')
    return !line.backfill && !pending.seenBefore.includes(k.key);
  return true;
}

/** A mic silent for longer than MIC_GAP_MS has probably been passed on. */
export function micGapExpired(
  lastLineAt: number | undefined,
  at: number,
): boolean {
  return lastLineAt !== undefined && at - lastLineAt > MIC_GAP_MS;
}

/**
 * The bindings a stream reopening ends: every open one on a voice, whatever
 * its status, because the voice indexes are about to start again from 0.
 */
export function bindingsEndedByReopen<T extends Binding>(
  bindings: readonly T[],
): T[] {
  return bindings.filter(
    (b) => b.kind === 'speaker' && b.toAt === null && b.status !== 'rejected',
  );
}

/**
 * The applied bindings a new applied one on the same kind/key cuts short:
 * those that started before it and are still open (or run past) its start.
 */
export function bindingsClosedBy<T extends Binding>(
  bindings: readonly T[],
  incoming: Pick<Binding, 'kind' | 'key' | 'fromAt'>,
  ignoreId?: string,
): T[] {
  const from = incoming.fromAt.getTime();
  return bindings.filter(
    (b) =>
      (ignoreId === undefined || (b as T & { id?: string }).id !== ignoreId) &&
      isApplied(b) &&
      b.kind === incoming.kind &&
      b.key === incoming.key &&
      b.fromAt.getTime() < from &&
      (b.toAt === null || b.toAt.getTime() > from),
  );
}

export interface ProgrammeSpeaker {
  id: string;
  name: string;
  organisation: string | null;
}

/**
 * The programme speaker a heard name is, by the model's id when it gave a
 * real one, else by the name itself (case and spacing aside).
 */
export function matchProgramme(
  speakers: readonly ProgrammeSpeaker[],
  programmeSpeakerId: string | null,
  name: string | null,
): ProgrammeSpeaker | null {
  if (programmeSpeakerId) {
    const byId = speakers.find((s) => s.id === programmeSpeakerId);
    if (byId) return byId;
  }
  const wanted = fold(name ?? '');
  if (!wanted) return null;
  return speakers.find((s) => fold(s.name) === wanted) ?? null;
}

const fold = (s: string) =>
  s
    .toLowerCase()
    .replace(/\b(dr|prof|professor|mr|mrs|ms|hon|chief|engr)\.?\s+/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** What the review found for one stretch of lines. */
export interface ReviewFinding {
  kind: SpeakerNameKind;
  key: number;
  name: string;
  organisation: string | null;
  programmeSpeakerId: string | null;
  /** 1-based, inclusive. */
  fromLine: number;
  toLine: number;
  confidence: number;
}

export interface ExistingBinding extends Binding {
  id: string;
  source: SpeakerNameSource;
}

export interface NewBinding {
  kind: SpeakerNameKind;
  key: number;
  name: string;
  organisation: string | null;
  speakerId: string | null;
  status: 'auto' | 'suggested';
  fromAt: Date;
  toAt: Date | null;
}

export interface ReviewPlan {
  add: NewBinding[];
  /** Ids of the auto/suggested bindings the additions replace. */
  remove: string[];
  /** Findings dropped: low confidence, bad lines, ignored by the setting, or operator-owned stretches. */
  skipped: number;
}

/**
 * How a review's findings change the session's bindings. A finding becomes
 * a binding from its first line to the line after its last (or open, at the
 * end), under the same auto/suggest rule as a live introduction. It replaces
 * the auto and suggested bindings it overlaps on the same kind/key, unless
 * one of them already says the same thing; it never touches a confirmed or
 * operator binding, and is dropped where one is in the way.
 */
export function planReview(
  findings: readonly ReviewFinding[],
  lines: readonly { at: number }[],
  existing: readonly ExistingBinding[],
  setting: ReviewNaming,
  speakers: readonly ProgrammeSpeaker[],
): ReviewPlan {
  const add: NewBinding[] = [];
  const remove = new Set<string>();
  let skipped = 0;
  for (const f of findings) {
    if (
      f.confidence < MIN_CONFIDENCE ||
      !Number.isInteger(f.fromLine) ||
      !Number.isInteger(f.toLine) ||
      f.fromLine < 1 ||
      f.toLine < f.fromLine ||
      f.toLine > lines.length
    ) {
      skipped += 1;
      continue;
    }
    const speaker = matchProgramme(speakers, f.programmeSpeakerId, f.name);
    const name = (speaker?.name ?? f.name).trim().slice(0, 255);
    const status = statusFor(setting, !!speaker);
    if (!name || !status) {
      skipped += 1;
      continue;
    }
    const fromAt = new Date(lines[f.fromLine - 1].at);
    const toAt = f.toLine < lines.length ? new Date(lines[f.toLine].at) : null;
    const overlapping = existing.filter(
      (b) =>
        b.kind === f.kind &&
        b.key === f.key &&
        b.status !== 'rejected' &&
        b.fromAt.getTime() < (toAt?.getTime() ?? Infinity) &&
        (b.toAt === null || b.toAt.getTime() > fromAt.getTime()),
    );
    const protectedBy = overlapping.some(
      (b) => b.status === 'confirmed' || b.source === 'operator',
    );
    if (protectedBy) {
      skipped += 1;
      continue;
    }
    const same = overlapping.some(
      (b) =>
        fold(b.name) === fold(name) &&
        b.status === status &&
        b.fromAt.getTime() === fromAt.getTime() &&
        (b.toAt?.getTime() ?? null) === (toAt?.getTime() ?? null),
    );
    if (same) continue;
    for (const b of overlapping) remove.add(b.id);
    add.push({
      kind: f.kind,
      key: f.key,
      name,
      organisation:
        (speaker?.organisation ?? f.organisation)?.trim().slice(0, 255) || null,
      speakerId: speaker?.id ?? null,
      status,
      fromAt,
      toAt,
    });
  }
  return { add, remove: [...remove], skipped };
}
