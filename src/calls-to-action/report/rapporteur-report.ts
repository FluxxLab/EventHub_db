import { z } from 'zod';

/**
 * The rapporteur's report for one session, as Claude writes it from the
 * session's named transcript, following the Build Conference rapporteur
 * briefing note: strategic insights, not minutes. The console fills it into
 * the Word template (the Rapporteur Session Guide), one table per section.
 *
 * The approved calls to action go in as the source of the report's
 * recommendations and commitments: organisers have already vetted them, so
 * the report keeps them apart (a recommendation is asked for, a commitment
 * is promised) and only adds the owner, next step and follow-up.
 */

const Insight = z.object({
  insight: z.string(),
  whyItMatters: z.string(),
  evidence: z.string(),
  implications: z.string(),
});
const Opportunity = z.object({
  opportunity: z.string(),
  value: z.string(),
  conditions: z.string(),
});
const Challenge = z.object({
  challenge: z.string(),
  disenablers: z.string(),
  mitigation: z.string(),
  stakeholder: z.string(),
});
const Recommendation = z.object({
  recommendation: z.string(),
  owner: z.string(),
  nextStep: z.string(),
  timeframe: z.string(),
});
const Commitment = z.object({
  commitment: z.string(),
  who: z.string(),
  timeframe: z.string(),
  followUpLead: z.string(),
});

export const RapporteurReportAnswer = z.object({
  purpose: z.string(),
  attendees: z.string(),
  insights: z.array(Insight),
  perspectives: z.array(z.string()),
  opportunities: z.array(Opportunity),
  challenges: z.array(Challenge),
  recommendations: z.array(Recommendation),
  commitments: z.array(Commitment),
  synthesis: z.string(),
});
export type RapporteurReportAnswer = z.infer<typeof RapporteurReportAnswer>;

/** What the report is written from, besides the transcript. */
export type ReportBrief = {
  event: string;
  session: string;
  description: string | null;
  speakers: string[];
  /** The session's approved calls, as the organisers worded them. */
  calls: {
    type: 'recommendation' | 'pledge';
    action: string;
    directedAt: string;
    proposedBy: string | null;
    deadline: string | null;
    amount: string | null;
  }[];
};

/** How many rows each section keeps: the template's three, more where the session had more. */
export const LIMITS = {
  insights: 3,
  perspectives: 3,
  opportunities: 3,
  challenges: 3,
  recommendations: 8,
  commitments: 8,
} as const;

export const REPORT_INSTRUCTIONS = `You are the rapporteur for a session at a policy and technology conference in Nigeria. You write the session's report from its transcript, following the conference's rapporteur briefing note.

Your role is to capture high-level strategic insight, not to transcribe or write minutes. Distil the key ideas, recurring themes, diverse perspectives, notable commitments and actionable recommendations.

While reading, keep asking:
1. What is the most important idea?
2. Why does it matter, and to whom?
3. What evidence or experience supports it?
4. Where do participants agree, disagree, or remain uncertain?
5. What should happen next, by whom, and when?

Do: synthesise neutrally, retain nuance, surface diverse views, and distinguish recommendations from commitments.
Do not: transcribe, record every intervention, overstate consensus, add personal opinions, or attribute sensitive comments to a named person.

The report's sections:
- purpose: the session's purpose in one sentence.
- attendees: who took part on stage (speakers, moderators), by name and organisation where known, as one short line. Never list audience members by name.
- insights: the three most consequential findings. For each: the core idea; why it matters and to whom (stakeholder perspectives); the evidence or experience cited; its implication for policy, practice, investment, implementation or governance.
- perspectives: up to three points where participants disagreed or highlighted competing priorities, a key tension, or an important voice that was missing or overlooked. One or two sentences each.
- opportunities: up to three high-impact opportunities or technical prerequisites identified to unlock value: the opportunity, its expected value or outcome (and who benefits), and the key conditions or safeguards for success.
- challenges: up to three principal barriers, risks or unresolved issues: the challenge or risk, its disenablers (what causes or worsens it), the proposed mitigation, and the stakeholder best placed to act.
- recommendations: the top recommendations, things participants asked others to do. Start from the approved recommendations you are given, in their wording; add the proposed owner or lead, the immediate next step and the timeframe from the transcript. Add others only if they were clearly made in the session.
- commitments: explicit commitments only: institutional pledges, funding announcements, pilots, or partnerships that a named party said it will do. Not expressions of interest, aspirations or suggestions. Start from the approved commitments you are given; add who made it, the timeframe and the follow-up lead.
- synthesis: a short closing paragraph on the session's flow, insights and observations, ending with one sentence on why the discussion matters.

Write in clear British English, in full sentences, without bullet characters. Be concise: a table cell is one to three sentences. Where something was not said (an owner, a timeframe), write "Not stated" rather than inventing it. If the session had fewer than three of something, give only what it had.`;

/** The user turn: the event, the session, its approved calls and the transcript. */
export function reportPrompt(brief: ReportBrief, transcript: string): string {
  const calls = brief.calls.length
    ? brief.calls
        .map(
          (c, i) =>
            `${i + 1}. [${c.type === 'pledge' ? 'commitment' : 'recommendation'}] ${c.action} (for: ${c.directedAt}${c.proposedBy ? `; by: ${c.proposedBy}` : ''}${c.deadline ? `; timeline: ${c.deadline}` : ''}${c.amount ? `; amount: ${c.amount}` : ''})`,
        )
        .join('\n')
    : 'None approved yet: draw recommendations and commitments from the transcript, holding commitments to the strict test.';
  return [
    `Event: ${brief.event}`,
    `Session: ${brief.session}`,
    brief.description ? `Session description: ${brief.description}` : null,
    brief.speakers.length
      ? `Programmed speakers: ${brief.speakers.join('; ')}`
      : null,
    '',
    'Approved calls to action from this session (vetted by the organisers):',
    calls,
    '',
    'Transcript (time, speaker where known, words):',
    transcript,
    '',
    "Write the session's rapporteur report.",
  ]
    .filter((l) => l !== null)
    .join('\n');
}

const tidy = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    .replace(/^[-•*]\s*/, '')
    .trim();
const filled = (s: string) => tidy(s) || 'Not stated';

/**
 * The answer made safe to fill in: text trimmed, empty cells "Not stated",
 * empty rows dropped, and each section held to its length.
 */
export function cleanReport(a: RapporteurReportAnswer): RapporteurReportAnswer {
  const rows = <T extends Record<string, string>>(
    list: T[],
    first: keyof T,
    max: number,
  ): T[] =>
    list
      .filter((r) => tidy(r[first]))
      .slice(0, max)
      .map(
        (r) =>
          Object.fromEntries(
            Object.entries(r).map(([k, v]) => [k, filled(v)]),
          ) as T,
      );
  return {
    purpose: filled(a.purpose),
    attendees: filled(a.attendees),
    insights: rows(a.insights, 'insight', LIMITS.insights),
    perspectives: a.perspectives
      .map(tidy)
      .filter(Boolean)
      .slice(0, LIMITS.perspectives),
    opportunities: rows(a.opportunities, 'opportunity', LIMITS.opportunities),
    challenges: rows(a.challenges, 'challenge', LIMITS.challenges),
    recommendations: rows(
      a.recommendations,
      'recommendation',
      LIMITS.recommendations,
    ),
    commitments: rows(a.commitments, 'commitment', LIMITS.commitments),
    synthesis: filled(a.synthesis),
  };
}
