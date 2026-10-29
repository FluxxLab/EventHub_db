import {
  assembleBrief,
  topBriefPrompt,
  type StoredCall,
  type TopBriefAnswer,
} from './top-brief';

const call = (over: Partial<StoredCall> = {}): StoredCall => ({
  type: 'recommendation',
  approved: true,
  action: 'Map national compute capacity.',
  directedAt: 'Federal Government',
  proposedBy: 'Uchechukwu Arinze',
  proposedByOrganisation: 'Jeremiah Arinze Foundation',
  alsoProposedBy: [],
  deadline: null,
  amount: null,
  session: 'Research Presentation – Innovation Catalysis',
  quote: 'One is to map the capacity,',
  ...over,
});

const pick = (ref: number, alsoRefs: number[] = []) => ({
  ref,
  alsoRefs,
  title: `  Pick ${ref}  `,
  detail: 'What it involves.',
  whyItRanks: 'Raised in two sessions.',
});

const answer = (over: Partial<TopBriefAnswer> = {}): TopBriefAnswer => ({
  summary: 'Compute, power and follow-through.',
  recommendations: [],
  commitments: [],
  honourableMentions: [],
  ...over,
});

describe('the top brief', () => {
  it('takes speakers, quotes and sessions from the stored calls, folding in the others', () => {
    const calls = [
      call(),
      call({
        proposedBy: 'Olayinka Iyinlokan',
        proposedByOrganisation: null,
        alsoProposedBy: ['Prof. Victor Odumuyiwa'],
        quote: null,
        deadline: 'By 2027',
        session: 'Building Africa’s AI Human Capital',
      }),
    ];
    const brief = assembleBrief(
      answer({ recommendations: [pick(1, [2])] }),
      calls,
      5,
    );
    expect(brief.recommendations).toEqual([
      {
        rank: 1,
        title: 'Pick 1',
        detail: 'What it involves.',
        whyItRanks: 'Raised in two sessions.',
        directedAt: 'Federal Government',
        raisedBy: [
          'Uchechukwu Arinze (Jeremiah Arinze Foundation)',
          'Olayinka Iyinlokan',
          'Prof. Victor Odumuyiwa',
        ],
        quote: 'One is to map the capacity,',
        deadline: 'By 2027',
        amount: null,
        session: 'Research Presentation – Innovation Catalysis',
        pending: false,
      },
    ]);
  });

  it('drops refs out of range, of the other kind or already used, and holds each list to the count', () => {
    const calls = [
      call(),
      call({ type: 'pledge', approved: false }),
      call({ proposedBy: 'B', session: 'S2' }),
      call({ proposedBy: 'C', session: 'S3' }),
    ];
    const brief = assembleBrief(
      answer({
        recommendations: [pick(9), pick(2), pick(1), pick(1), pick(3), pick(4)],
        commitments: [pick(1), pick(2)],
        honourableMentions: ['a', '', 'b', 'c', 'd'],
      }),
      calls,
      2,
    );
    expect(brief.recommendations.map((r) => r.title)).toEqual([
      'Pick 1',
      'Pick 3',
    ]);
    expect(brief.recommendations.map((r) => r.rank)).toEqual([1, 2]);
    expect(brief.commitments).toHaveLength(1);
    expect(brief.commitments[0]!.pending).toBe(true);
    expect(brief.honourableMentions).toEqual(['a', 'b', 'c']);
  });

  it('spreads the picks across speakers and sessions, using reserves first', () => {
    const calls = [
      call({ proposedBy: 'Ann', session: 'S1' }),
      call({ proposedBy: 'Ann', session: 'S1' }), // same speaker: waits
      call({ proposedBy: 'Bo', session: 'S1' }),
      call({ proposedBy: 'Cy', session: 'S1' }), // third from S1: waits
      call({ proposedBy: 'Di', session: 'S2' }),
    ];
    const picks = [1, 2, 3, 4, 5].map((r) => pick(r));
    expect(
      assembleBrief(
        answer({ recommendations: picks }),
        calls,
        3,
      ).recommendations.map((r) => r.title),
    ).toEqual(['Pick 1', 'Pick 3', 'Pick 5']);
    // with too few others, the held-back picks fill the list, in Claude's order
    const four = assembleBrief(answer({ recommendations: picks }), calls, 4);
    expect(four.recommendations.map((r) => r.title)).toEqual([
      'Pick 1',
      'Pick 2',
      'Pick 3',
      'Pick 5',
    ]);
    expect(four.recommendations.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
  });

  it('numbers the calls for Claude and marks those pending review', () => {
    const prompt = topBriefPrompt(
      'Build 2026',
      5,
      [
        call(),
        call({ type: 'pledge', approved: false, alsoProposedBy: ['NCDC'] }),
      ].map(({ quote: _q, ...c }) => c),
    );
    expect(prompt).not.toContain('Theme');
    expect(prompt).toContain('(2, from 1 sessions)');
    expect(prompt).toContain(
      '1. [recommendation] Map national compute capacity.',
    );
    expect(prompt).toContain('2. [commitment, pending review]');
    expect(prompt).toContain('also raised by: NCDC');
    expect(prompt).not.toContain('One is to map');
    expect(prompt).toContain(
      'Pick the top 5 recommendations and the top 5 commitments from across the whole event',
    );
    expect(prompt).toContain('10 of each kind in all');
  });
});
