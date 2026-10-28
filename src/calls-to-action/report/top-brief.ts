import { z } from 'zod';

/**
 * The event's abridged brief: the few recommendations and commitments most
 * relevant to the event's theme, picked by Claude from all the calls to
 * action organisers have kept. Claude only chooses and words the headline;
 * who said it, to whom, and their exact words come from the stored calls, so
 * nothing in the brief is attributed that was not captioned.
 */

const Pick = z.object({
  /** The number of the call in the list it was given. */
  ref: z.number().int(),
  /** Other calls in the list that ask for the same thing, folded into this one. */
  alsoRefs: z.array(z.number().int()),
  /** The headline: what should be done, in one sentence. */
  title: z.string(),
  /** One or two sentences on what it involves. */
  detail: z.string(),
  /** One sentence on why it ranks this high for the theme. */
  whyItRanks: z.string(),
});

export const TopBriefAnswer = z.object({
  /** One or two sentences: what the picks add up to for the theme. */
  summary: z.string(),
  recommendations: z.array(Pick),
  commitments: z.array(Pick),
  /** Up to three short lines on strong items just outside the top picks. */
  honourableMentions: z.array(z.string()),
});
export type TopBriefAnswer = z.infer<typeof TopBriefAnswer>;

/** A call as Claude is shown it. */
export type BriefCall = {
  type: 'recommendation' | 'pledge';
  approved: boolean;
  action: string;
  directedAt: string;
  proposedBy: string | null;
  proposedByOrganisation: string | null;
  alsoProposedBy: string[];
  deadline: string | null;
  amount: string | null;
  session: string | null;
};

export const TOP_BRIEF_INSTRUCTIONS = `You prepare an abridged brief for the organisers of a policy and technology conference in Africa. From the conference's calls to action, you pick the recommendations and the commitments most relevant to the conference theme.

A recommendation asks someone else to act. A commitment (pledge) is a named party saying it will act. Never move an item from one kind to the other.

Rank by, in order:
1. How directly it advances the conference theme. Items about the theme's core outrank items about related topics such as skills or inclusion.
2. How widely it was raised: several speakers or sessions asking for the same thing outrank one voice. Count the "also raised by" names and similar items in other sessions.
3. How actionable it is: a named owner, a deadline, an amount or a concrete next step.
4. Items approved by the organisers outrank those still pending review, when otherwise close.

Several items often ask for the same thing in different sessions. Fold them into one pick: the strongest as "ref", the others in "alsoRefs". Each item appears in at most one pick.

For each pick:
- title: the action in one sentence, starting with a verb (a commitment starts with who will act: "NCDC will ...").
- detail: one or two sentences on what it involves, taken from the items' own wording. Add nothing the items do not say.
- whyItRanks: one sentence, plain and specific (for example "Raised in three sessions, and names the owner and a deadline.").

summary: one or two sentences on what the picks together say about the theme.
honourableMentions: up to three short lines naming strong items that just missed the cut and why.

Write in clear British English. No bullet characters, no emoji. Give exactly the number of picks asked for of each kind, or fewer when there are not enough relevant items.`;

/** The user turn: the theme, how many to pick, and every call, numbered. */
export function topBriefPrompt(
  event: string,
  theme: string,
  count: number,
  calls: BriefCall[],
): string {
  const line = (c: BriefCall, i: number) =>
    [
      `${i + 1}. [${c.type === 'pledge' ? 'commitment' : 'recommendation'}${c.approved ? '' : ', pending review'}] ${c.action}`,
      `   for: ${c.directedAt}`,
      c.proposedBy
        ? `   by: ${c.proposedBy}${c.proposedByOrganisation ? ` (${c.proposedByOrganisation})` : ''}`
        : null,
      c.alsoProposedBy.length
        ? `   also raised by: ${c.alsoProposedBy.join('; ')}`
        : null,
      c.deadline ? `   timeline: ${c.deadline}` : null,
      c.amount ? `   amount: ${c.amount}` : null,
      c.session ? `   session: ${c.session}` : null,
    ]
      .filter((l) => l !== null)
      .join('\n');
  return [
    `Event: ${event}`,
    `Theme: ${theme}`,
    '',
    `The calls to action (${calls.length}):`,
    calls.map(line).join('\n'),
    '',
    `Pick the top ${count} recommendations and the top ${count} commitments for the theme.`,
  ].join('\n');
}

const tidy = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    .replace(/^[-•*]\s*/, '')
    .trim();

/** One pick, as the console prints it. */
export type BriefItem = {
  rank: number;
  title: string;
  detail: string;
  whyItRanks: string;
  directedAt: string;
  /** Who said it, the main item's speaker first. */
  raisedBy: string[];
  quote: string | null;
  deadline: string | null;
  amount: string | null;
  session: string | null;
  /** Still to be approved by the organisers. */
  pending: boolean;
};

/** A stored call, with what the brief prints about it. */
export type StoredCall = BriefCall & { quote: string | null };

/**
 * The answer joined back to the stored calls: refs out of range, of the
 * wrong kind or already used are dropped, each list held to `count`, and
 * the speakers, quote and session taken from the calls themselves.
 */
export function assembleBrief(
  answer: TopBriefAnswer,
  calls: StoredCall[],
  count: number,
): {
  summary: string;
  recommendations: BriefItem[];
  commitments: BriefItem[];
  honourableMentions: string[];
} {
  const used = new Set<number>();
  const at = (ref: number) =>
    Number.isInteger(ref) && ref >= 1 && ref <= calls.length
      ? calls[ref - 1]
      : undefined;
  const speaker = (c: StoredCall) =>
    c.proposedBy
      ? `${c.proposedBy}${c.proposedByOrganisation ? ` (${c.proposedByOrganisation})` : ''}`
      : null;
  const items = (
    picks: TopBriefAnswer['recommendations'],
    type: 'recommendation' | 'pledge',
  ) => {
    const out: BriefItem[] = [];
    for (const p of picks) {
      if (out.length >= count) break;
      const main = at(p.ref);
      if (!main || main.type !== type || used.has(p.ref) || !tidy(p.title))
        continue;
      used.add(p.ref);
      const others = p.alsoRefs
        .filter((r) => r !== p.ref && !used.has(r) && at(r)?.type === type)
        .map((r) => {
          used.add(r);
          return at(r)!;
        });
      const raisedBy = [
        ...new Set(
          [main, ...others]
            .flatMap((c) => [speaker(c), ...c.alsoProposedBy])
            .filter((n): n is string => !!n && !!n.trim()),
        ),
      ];
      const source = [main, ...others];
      out.push({
        rank: out.length + 1,
        title: tidy(p.title),
        detail: tidy(p.detail),
        whyItRanks: tidy(p.whyItRanks),
        directedAt: main.directedAt,
        raisedBy,
        quote: source.find((c) => c.quote?.trim())?.quote?.trim() ?? null,
        deadline: source.find((c) => c.deadline)?.deadline ?? null,
        amount: source.find((c) => c.amount)?.amount ?? null,
        session: main.session,
        pending: source.every((c) => !c.approved),
      });
    }
    return out;
  };
  return {
    summary: tidy(answer.summary),
    recommendations: items(answer.recommendations, 'recommendation'),
    commitments: items(answer.commitments, 'pledge'),
    honourableMentions: answer.honourableMentions
      .map(tidy)
      .filter(Boolean)
      .slice(0, 3),
  };
}
