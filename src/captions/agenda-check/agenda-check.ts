import { z } from 'zod';

/**
 * Checking a room's captions against its agenda.
 *
 * When the wrong session is left live, a talk is captioned (and analysed)
 * under a session it is not. This lines up one room's day: the agenda, and
 * every caption line in time order with the session it is filed under, and
 * asks Claude where the names called and the subject show a stretch belongs
 * to another session. Nothing is changed here: each finding becomes a move an
 * organiser confirms.
 */

export type AgendaSession = {
  id: string;
  title: string;
  type: string;
  status: string;
  startsAt: Date;
  endsAt: Date;
  speakers: { name: string; organisation: string | null }[];
  brief: string | null;
};

export type FiledLine = {
  sessionId: string;
  at: number;
  name: string | null;
  text: string;
};

/** Consecutive lines of one session and one voice, read as one turn. */
export type Turn = {
  id: string;
  sessionId: string;
  from: number;
  to: number;
  name: string | null;
  text: string;
  lines: number;
};

const TURN_GAP_MS = 20_000;
const TURN_MAX_CHARS = 600;
/** Kept under this many characters of transcript in one request. */
const MAX_TRANSCRIPT_CHARS = 350_000;

/** The room's lines as turns, in time order, numbered T1, T2… */
export function toTurns(lines: FiledLine[]): Turn[] {
  const sorted = [...lines]
    .filter((l) => l.text.trim() && Number.isFinite(l.at))
    .sort((a, b) => a.at - b.at);
  const turns: Turn[] = [];
  for (const l of sorted) {
    const last = turns.at(-1);
    if (
      last &&
      last.sessionId === l.sessionId &&
      last.name === l.name &&
      l.at - last.to <= TURN_GAP_MS &&
      last.text.length + l.text.length < TURN_MAX_CHARS
    ) {
      last.text += ` ${l.text.trim()}`;
      last.to = l.at;
      last.lines++;
    } else {
      turns.push({
        id: `T${turns.length + 1}`,
        sessionId: l.sessionId,
        from: l.at,
        to: l.at,
        name: l.name,
        text: l.text.trim(),
        lines: 1,
      });
    }
  }
  return turns;
}

/** "13:05:07" in Abuja (WAT, UTC+1). */
export const watClock = (ms: number, seconds = true) =>
  new Date(ms + 3_600_000).toISOString().slice(11, seconds ? 19 : 16);

export const AGENDA_INSTRUCTIONS = `You check a conference room's live captions against its agenda, for organisers in Nigeria. Operators switch which session is "live" by hand, and sometimes forget, so a talk can be captioned under the wrong session: the session before it, or the one after.

You get the room's agenda (S1, S2… with scheduled times, speakers and what each is about) and every caption turn in time order (T1, T2…), each marked with the session it is FILED under.

Decide where each stretch of talk really belongs, using, in this order of weight:
1. Names called: a host introducing a speaker or panel ("please welcome…", "over to you, Dr…"), a moderator calling on someone, speakers named on the agenda being addressed or speaking.
2. The subject: what is discussed against each session's title and brief.
3. Timing: the scheduled times, which often slip, so they only break a tie.

Report:
- sessions: for every agenda session that has turns filed under it, whether what was said there matches its topic (matches, partly, does_not_match) with a short note.
- misfiled: each continuous stretch filed under the wrong session: its first and last turn, the session it is filed as, and the session it belongs to (or "none" for breaks, housekeeping or talk that fits no session). Give the names you heard that show it, an exact quote of at most 40 words copied from those turns, a reason under 25 words, and your confidence from 0 to 1.

Only report a stretch you are sure of. A session running late, a Q&A that belongs to the talk before it, or a host's handover line is not misfiled. If everything is filed correctly, misfiled is empty.`;

export const AgendaAnswer = z.object({
  sessions: z.array(
    z.object({
      session: z.string(),
      fit: z.enum(['matches', 'partly', 'does_not_match']),
      note: z.string(),
    }),
  ),
  misfiled: z.array(
    z.object({
      fromTurn: z.string(),
      toTurn: z.string(),
      filedAs: z.string(),
      belongsTo: z.string(),
      confidence: z.number(),
      namesHeard: z.array(z.string()),
      evidence: z.string(),
      reason: z.string(),
    }),
  ),
});
export type AgendaAnswer = z.infer<typeof AgendaAnswer>;

/** The request: the agenda, then the turns. Long turns are cut when the day is very long. */
export function agendaPrompt(
  room: string,
  day: number,
  agenda: AgendaSession[],
  turns: Turn[],
): string {
  const label = new Map(agenda.map((s, i) => [s.id, `S${i + 1}`]));
  const head = [
    `Room: ${room}, day ${day}. Times are Abuja time.`,
    '',
    'AGENDA',
    ...agenda.map((s, i) => {
      const who = s.speakers
        .map((p) => (p.organisation ? `${p.name} (${p.organisation})` : p.name))
        .join('; ');
      const brief = s.brief?.replace(/\s+/g, ' ').trim().slice(0, 500);
      return [
        `S${i + 1} ${watClock(s.startsAt.getTime(), false)}–${watClock(s.endsAt.getTime(), false)} [${s.type}] "${s.title}" (status: ${s.status})`,
        who ? `   Speakers: ${who}` : '',
        brief ? `   About: ${brief}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    }),
    '',
    'TRANSCRIPT (turn, time, filed under, speaker if known: words)',
  ].join('\n');
  const total = turns.reduce((n, t) => n + t.text.length, 0);
  const cut =
    total > MAX_TRANSCRIPT_CHARS
      ? Math.max(
          120,
          Math.floor((MAX_TRANSCRIPT_CHARS / total) * TURN_MAX_CHARS),
        )
      : Infinity;
  const body = turns.map(
    (t) =>
      `${t.id} ${watClock(t.from)} [${label.get(t.sessionId) ?? '?'}]${t.name ? ` ${t.name}:` : ''} ${t.text.length > cut ? `${t.text.slice(0, cut)}…` : t.text}`,
  );
  return `${head}\n${body.join('\n')}`;
}

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

export type AgendaFix = {
  fromSessionId: string;
  /** null: the stretch fits no session (a break, housekeeping). */
  toSessionId: string | null;
  /** First and last moment of the stretch's lines filed under fromSessionId. */
  since: string;
  until: string;
  lines: number;
  confidence: number;
  namesHeard: string[];
  evidence: string;
  reason: string;
};

export type AgendaFit = {
  sessionId: string;
  fit: 'matches' | 'partly' | 'does_not_match';
  note: string;
};

/**
 * What can be acted on from Claude's answer: known turns and sessions, a
 * stretch that is filed where it says, sure enough, and a quote that is in
 * those turns (most of its words), so a made-up finding is dropped.
 */
export function cleanAnswer(
  answer: AgendaAnswer,
  agenda: AgendaSession[],
  turns: Turn[],
  minConfidence = 0.75,
): { fits: AgendaFit[]; fixes: AgendaFix[] } {
  const byLabel = new Map(agenda.map((s, i) => [`S${i + 1}`, s.id]));
  const index = new Map(turns.map((t, i) => [t.id, i]));
  const fits: AgendaFit[] = answer.sessions
    .filter((s) => byLabel.has(s.session.trim()))
    .map((s) => ({
      sessionId: byLabel.get(s.session.trim())!,
      fit: s.fit,
      note: s.note.trim(),
    }));

  const fixes: AgendaFix[] = [];
  for (const m of answer.misfiled) {
    const from = byLabel.get(m.filedAs.trim());
    const toLabel = m.belongsTo.trim();
    const to = toLabel.toLowerCase() === 'none' ? null : byLabel.get(toLabel);
    if (!from || to === undefined || to === from) continue;
    if (!(m.confidence >= minConfidence)) continue;
    let a = index.get(m.fromTurn.trim());
    let b = index.get(m.toTurn.trim());
    if (a === undefined || b === undefined) continue;
    if (a > b) [a, b] = [b, a];
    const stretch = turns.slice(a, b + 1).filter((t) => t.sessionId === from);
    if (!stretch.length) continue;
    const heard = new Set(
      words(
        turns
          .slice(a, b + 1)
          .map((t) => t.text)
          .join(' '),
      ),
    );
    const quote = words(m.evidence);
    if (
      quote.length < 4 ||
      quote.filter((w) => heard.has(w)).length / quote.length < 0.8
    )
      continue;
    fixes.push({
      fromSessionId: from,
      toSessionId: to,
      since: new Date(stretch[0].from).toISOString(),
      until: new Date(stretch.at(-1)!.to).toISOString(),
      lines: stretch.reduce((n, t) => n + t.lines, 0),
      confidence: Math.min(1, m.confidence),
      namesHeard: m.namesHeard
        .map((n) => n.trim())
        .filter(Boolean)
        .slice(0, 8),
      evidence: m.evidence.trim(),
      reason: m.reason.trim(),
    });
  }
  return { fits, fixes };
}
