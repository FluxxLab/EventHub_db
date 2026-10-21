/**
 * Spotting a room's changeover from its captions: the next session has
 * started (its speakers are introduced, its title is announced) or the live
 * one has ended (thanks, the close, the break). Pure: the service reads the
 * programme and the captions and hands them in.
 *
 * Three gates keep it cheap and quiet. A room is looked at only around a
 * scheduled changeover; Claude is asked only when the captions carry a cue a
 * changeover would; and what Claude answers is kept only when the words it
 * rests on are in the captions and it is confident. Even then it is a
 * suggestion: a person switches.
 */

import { z } from 'zod';
import type { SwitchKind } from './switch-suggestion.entity';

export type PlannedSession = {
  id: string;
  title: string;
  day: number;
  startsAt: Date;
  endsAt: Date;
  room: string;
  status: string;
  speakers?: { name: string; organisation?: string | null }[];
};

export type RoomPlan = {
  room: string;
  live: PlannedSession;
  /** The next scheduled session in the room the same day, or null. */
  next: PlannedSession | null;
};

const MIN = 60_000;
/** How long before the next session's scheduled start to begin listening for it. */
export const LISTEN_BEFORE_START = 10 * MIN;
/** How long after its scheduled start to keep listening, for a room running late. */
export const LISTEN_AFTER_START = 60 * MIN;
/** How long before the live session's scheduled end to begin listening for its close. */
export const LISTEN_BEFORE_END = 5 * MIN;

/**
 * Each room with a live session, with the next scheduled one there the same
 * day. Rooms with nothing live are left out: nothing is captioned in them, so
 * there is nothing to hear.
 */
export function roomPlans(sessions: PlannedSession[]): RoomPlan[] {
  const key = (r: string) => r.trim().toLowerCase();
  const plans: RoomPlan[] = [];
  for (const live of sessions.filter((s) => s.status === 'live')) {
    const next =
      sessions
        .filter(
          (s) =>
            s.status === 'scheduled' &&
            key(s.room) === key(live.room) &&
            s.day === live.day &&
            s.startsAt.getTime() > live.startsAt.getTime(),
        )
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0] ?? null;
    plans.push({ room: live.room, live, next });
  }
  return plans;
}

/**
 * What to listen for in a room now, or null outside a changeover. The next
 * session's start first; the live one's end when nothing follows soon after
 * it (a break, the end of the day).
 */
export function listenFor(plan: RoomPlan, now: Date): SwitchKind | null {
  const t = now.getTime();
  if (plan.next) {
    const start = plan.next.startsAt.getTime();
    if (t >= start - LISTEN_BEFORE_START && t <= start + LISTEN_AFTER_START)
      return 'start_next';
  }
  const end = plan.live.endsAt.getTime();
  const gap = plan.next ? plan.next.startsAt.getTime() - end : Infinity;
  if (
    gap > 20 * MIN &&
    t >= end - LISTEN_BEFORE_END &&
    t <= end + LISTEN_AFTER_START
  )
    return 'end_current';
  return null;
}

const plain = (s: string) =>
  ` ${s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;

const START_PHRASES = [
  'please welcome',
  'join me in welcoming',
  'lets welcome',
  'let us welcome',
  'welcome to this session',
  'welcome to the session',
  'our next session',
  'next session',
  'our next speaker',
  'next speaker',
  'our next panel',
  'i now invite',
  'i will now invite',
  'i invite',
  'the floor is yours',
  'over to you',
  'without further ado',
  'good morning everyone',
  'good afternoon everyone',
];
const END_PHRASES = [
  'that brings us to the end',
  'brings us to the end',
  'that concludes',
  'we have come to the end',
  'round of applause',
  'thank you all',
  'thank you very much',
  'we will now break',
  'well now break',
  'tea break',
  'lunch break',
  'see you after',
  'end of this session',
  'close this session',
];
const STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'into',
  'africa',
  'african',
  'nigeria',
  'nigerias',
  'session',
  'panel',
  'what',
  'their',
  'through',
]);
const HONORIFIC =
  /^(dr|prof|professor|mr|mrs|ms|barr|engr|hon|sir|chief|alhaji|rev|amb)$/;

/**
 * The cues in the captions that a changeover of this kind would leave, as
 * short labels for the log. Empty: not worth asking Claude.
 */
export function changeoverCues(
  captions: string[],
  kind: SwitchKind,
  plan: RoomPlan,
): string[] {
  const text = plain(captions.join(' '));
  const found: string[] = [];
  const phrases = kind === 'start_next' ? START_PHRASES : END_PHRASES;
  for (const p of phrases) if (text.includes(` ${p} `)) found.push(`"${p}"`);
  if (kind === 'start_next' && plan.next) {
    for (const sp of plan.next.speakers ?? []) {
      const words = plain(sp.name).trim().split(' ');
      while (words.length > 1 && HONORIFIC.test(words[0])) words.shift();
      const surname = words.at(-1);
      if (surname && surname.length > 3 && text.includes(` ${surname} `))
        found.push(`speaker ${sp.name}`);
    }
    const titleWords = [
      ...new Set(
        plain(plan.next.title)
          .trim()
          .split(' ')
          .filter((w) => w.length > 4 && !STOP.has(w)),
      ),
    ];
    const inTitle = titleWords.filter((w) => text.includes(` ${w} `));
    if (titleWords.length && inTitle.length >= Math.min(2, titleWords.length))
      found.push(`title words ${inTitle.slice(0, 3).join(', ')}`);
  }
  return found;
}

/* ----------------------------------------------------------------- Claude */

export const SWITCH_INSTRUCTIONS = `You watch the live captions of one room at a conference in Nigeria and tell the organisers when the room has changed over: the NEXT session has begun, or the CURRENT session has ended. A person confirms every suggestion before anything changes, but a wrong one sends every delegate a wrong notification and puts captions on the wrong session, so be sure.

next_started: the next session is under way. Its moderator or host has opened it, its speakers are being introduced to begin, or they are speaking on its subject. An announcement of what will come later ("after the break we will hear from…", "our next session is at two") is NOT a start.
current_ended: the current session has finished: it was closed, the room thanked and dismissed, or a break called, and nothing of it is continuing.
neither: anything else, including when you are unsure. Saying neither costs nothing.

Give confidence from 0 to 1. Copy the evidence exactly from the captions, at most 40 words, the words that show the changeover. Give the reason in under 20 words.`;

export const SwitchAnswer = z.object({
  verdict: z.enum(['next_started', 'current_ended', 'neither']),
  confidence: z.number(),
  evidence: z.string(),
  reason: z.string(),
});
export type SwitchAnswer = z.infer<typeof SwitchAnswer>;

export type CaptionLine = { at: Date; text: string };

const hm = (d: Date) =>
  d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Lagos',
  });
const describe = (s: PlannedSession) =>
  [
    `"${s.title}"`,
    `scheduled ${hm(s.startsAt)}–${hm(s.endsAt)}`,
    s.speakers?.length
      ? `speakers: ${s.speakers.map((sp) => (sp.organisation ? `${sp.name} (${sp.organisation})` : sp.name)).join('; ')}`
      : null,
  ]
    .filter(Boolean)
    .join(', ');

/** The user turn: the room, the time, the two sessions, and the recent captions. */
export function switchPrompt(
  plan: RoomPlan,
  lines: CaptionLine[],
  now: Date,
): string {
  return [
    `ROOM: ${plan.room}`,
    `NOW: ${hm(now)}`,
    `CURRENT SESSION (live): ${describe(plan.live)}`,
    `NEXT SESSION: ${plan.next ? describe(plan.next) : '(none today in this room)'}`,
    '',
    'CAPTIONS (most recent last):',
    ...lines.map((l) => `[${hm(l.at)}] ${l.text}`),
  ].join('\n');
}

/** Share of the evidence's words found in the captions, each caption word used once. */
function coverage(evidence: string, captions: string): number {
  const words = plain(evidence).trim().split(' ').filter(Boolean);
  if (!words.length) return 0;
  const bag = new Map<string, number>();
  for (const w of plain(captions).trim().split(' '))
    bag.set(w, (bag.get(w) ?? 0) + 1);
  let hit = 0;
  for (const w of words) {
    const n = bag.get(w) ?? 0;
    if (n) {
      bag.set(w, n - 1);
      hit += 1;
    }
  }
  return hit / words.length;
}

/**
 * The suggestion to show, or null. Kept only when the verdict is a
 * changeover the room can make (a start needs a next session), Claude is at
 * least `minConfidence` sure, and its evidence was really said: four words or
 * more, 80% of them in the captions.
 */
export function cleanVerdict(
  answer: SwitchAnswer,
  plan: RoomPlan,
  lines: CaptionLine[],
  minConfidence: number,
): {
  kind: SwitchKind;
  confidence: number;
  evidence: string;
  reason: string;
} | null {
  if (answer.verdict === 'neither') return null;
  const kind: SwitchKind =
    answer.verdict === 'next_started' ? 'start_next' : 'end_current';
  if (kind === 'start_next' && !plan.next) return null;
  const confidence = Math.max(0, Math.min(1, answer.confidence));
  if (confidence < minConfidence) return null;
  const evidence = answer.evidence.replace(/\s+/g, ' ').trim();
  if (evidence.split(' ').length < 4) return null;
  if (coverage(evidence, lines.map((l) => l.text).join(' ')) < 0.8) return null;
  return {
    kind,
    confidence,
    evidence: evidence.slice(0, 600),
    reason: answer.reason.replace(/\s+/g, ' ').trim().slice(0, 300),
  };
}
