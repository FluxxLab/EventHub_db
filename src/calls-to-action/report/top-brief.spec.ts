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
      call(),
      call(),
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

  it('numbers the calls for Claude and marks those pending review', () => {
    const prompt = topBriefPrompt(
      'Build 2026',
      'Shared compute',
      5,
      [
        call(),
        call({ type: 'pledge', approved: false, alsoProposedBy: ['NCDC'] }),
      ].map(({ quote: _q, ...c }) => c),
    );
    expect(prompt).toContain('Theme: Shared compute');
    expect(prompt).toContain(
      '1. [recommendation] Map national compute capacity.',
    );
    expect(prompt).toContain('2. [commitment, pending review]');
    expect(prompt).toContain('also raised by: NCDC');
    expect(prompt).not.toContain('One is to map');
    expect(prompt).toContain(
      'Pick the top 5 recommendations and the top 5 commitments',
    );
  });
});
