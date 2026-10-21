import { z } from 'zod';
import type { AnalysisLine } from './analysis.provider';

/**
 * Who said each call to action, read from the transcript itself.
 *
 * Captions often carry only voice labels ("Speaker 3"), so the name has to
 * come from what was said around the quote: a host's introduction ("please
 * welcome Dr Ajala"), a self-introduction ("my name is…"), a moderator
 * handing over ("over to you, Steven"), a thank-you after ("thank you,
 * Professor David-West"). A name is only kept when it is in the transcript
 * or on the session's programme, so nothing is invented.
 */

export const WHO_INSTRUCTIONS = `You read the transcript of one conference session in Nigeria and, for each numbered call to action, say who said it.

Lines are labelled with the voice ("Speaker 3") or a name when one is known. Work out the person from the transcript itself:
- introductions: a host or moderator introducing a speaker ("please welcome…", "I'll call on…", "over to you, Dr…"), or a speaker introducing themselves ("my name is…");
- the same voice label continuing after an introduction;
- thanks or references afterwards ("thank you, Professor…", "as Dr Ajala said…").

Use the SPEAKERS list to complete a name or find the organisation, never on its own to guess. If the transcript does not show who it was, answer null. A wrong name is worse than none.

For each item give the person's name as said or as on SPEAKERS, their organisation if the transcript or SPEAKERS gives it, the exact words (at most 30) that show who it was, and your confidence from 0 to 1.`;

export const WhoAnswer = z.object({
  items: z.array(
    z.object({
      ref: z.string(),
      name: z.string().nullable(),
      organisation: z.string().nullable(),
      evidence: z.string(),
      confidence: z.number(),
    }),
  ),
});
export type WhoAnswer = z.infer<typeof WhoAnswer>;

export type WhoItem = { ref: string; line: number; quote: string };

const hms = (d: Date) =>
  new Date(d.getTime() + 3_600_000).toISOString().slice(11, 19);

export function whoPrompt(
  session: string,
  speakers: string[],
  lines: AnalysisLine[],
  items: WhoItem[],
): string {
  return [
    `SESSION: ${session}`,
    `SPEAKERS:\n${speakers.length ? speakers.map((s) => `- ${s}`).join('\n') : '(none)'}`,
    `CALLS TO ACTION:\n${items.map((i) => `${i.ref} (line L${i.line}): "${i.quote}"`).join('\n')}`,
    `TRANSCRIPT:\n${lines.map((l) => `L${l.n} [${hms(l.at)}] ${l.who ?? 'Unknown'}: ${l.text}`).join('\n')}`,
  ].join('\n\n');
}

const plain = (s: string) =>
  ` ${s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;

const TITLES = new Set([
  'dr',
  'doctor',
  'prof',
  'professor',
  'mr',
  'mrs',
  'ms',
  'miss',
  'mister',
  'engr',
  'engineer',
  'hon',
  'honourable',
  'honorable',
  'barrister',
  'sir',
  'madam',
  'chief',
  'alhaji',
  'alhaja',
  'rev',
  'pastor',
]);

/**
 * Whether a name rests on something real: one of its words (not a title,
 * more than two letters) is in the transcript or the programme's speakers.
 */
export function nameIsGrounded(
  name: string,
  lines: AnalysisLine[],
  speakers: string[],
): boolean {
  const words = plain(name)
    .trim()
    .split(' ')
    .filter((w) => w.length > 2 && !TITLES.has(w));
  if (!words.length) return false;
  const heard = plain(lines.map((l) => `${l.text} ${l.who ?? ''}`).join(' '));
  const listed = plain(speakers.join(' '));
  return words.some(
    (w) => heard.includes(` ${w} `) || listed.includes(` ${w} `),
  );
}

/** The answers that can be saved: known refs, sure enough, and a name grounded in the session. */
export function cleanWho(
  answer: WhoAnswer,
  refs: Set<string>,
  lines: AnalysisLine[],
  speakers: string[],
  minConfidence = 0.7,
): Map<string, { name: string; organisation: string | null }> {
  const out = new Map<string, { name: string; organisation: string | null }>();
  for (const item of answer.items) {
    const name = item.name?.trim();
    if (!refs.has(item.ref) || !name || name.length > 200) continue;
    if (!(item.confidence >= minConfidence)) continue;
    if (
      /^(speaker|mic|voice)\s*\d+$/i.test(name) ||
      /unknown|moderator|host|audience/i.test(name)
    )
      continue;
    if (!nameIsGrounded(name, lines, speakers)) continue;
    out.set(item.ref, {
      name,
      organisation: item.organisation?.trim().slice(0, 200) || null,
    });
  }
  return out;
}
