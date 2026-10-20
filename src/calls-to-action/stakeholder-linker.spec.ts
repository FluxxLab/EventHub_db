import { cleanLinks, linkPrompt, type LinkRequest } from './stakeholder-linker';
import { reportPrompt } from './report/rapporteur-report';
import {
  mapStakeholders,
  presentLine,
  type StakeholderLinkView,
} from './stakeholders';

const request: LinkRequest = {
  event: 'Build Conference 2026',
  targets: [
    {
      target: 'Federal Government',
      examples: ['Fund shared compute for universities'],
    },
    { target: 'Development partners', examples: [] },
  ],
  organisations: ['NITDA', 'World Bank', 'Data Science Nigeria'],
};

describe('suggesting stakeholder links', () => {
  it('gives the model the targets with example calls, then the organisations', () => {
    const prompt = linkPrompt(request);
    expect(prompt).toContain(
      '- Federal Government\n  e.g. "Fund shared compute for universities"',
    );
    expect(prompt).toContain('- Development partners\n');
    expect(prompt.indexOf('TARGETS:')).toBeLessThan(
      prompt.indexOf('ORGANISATIONS:'),
    );
    expect(prompt).toContain('- World Bank');
  });

  it('keeps only targets and organisations it was given, once each, in their own spelling', () => {
    const out = cleanLinks(
      [
        {
          target: 'federal government',
          organisation: 'nitda',
          reason: '  Federal   agency ',
        },
        {
          target: 'Federal Government',
          organisation: 'NITDA',
          reason: 'again',
        },
        {
          target: 'Federal Government',
          organisation: 'Ministry of Finance',
          reason: 'invented',
        },
        {
          target: 'State governments',
          organisation: 'NITDA',
          reason: 'not asked',
        },
        {
          target: 'Development partners',
          organisation: 'World Bank',
          reason: 'Multilateral lender',
        },
      ],
      request,
    );
    expect(out).toEqual([
      {
        target: 'Federal Government',
        organisation: 'NITDA',
        reason: 'Federal agency',
      },
      {
        target: 'Development partners',
        organisation: 'World Bank',
        reason: 'Multilateral lender',
      },
    ]);
  });
});

describe('mapping with links', () => {
  const delegates = [
    {
      id: 'a',
      name: 'Ada',
      title: null,
      email: 'a@x.org',
      organisation:
        'National Information Technology Development Agency (NITDA)',
      admitted: true,
    },
    {
      id: 'b',
      name: 'Bo',
      title: null,
      email: 'b@x.org',
      organisation: 'World Bank',
      admitted: false,
    },
  ];
  const calls = [
    {
      id: 'r1',
      type: 'recommendation' as const,
      directedAt: 'Federal Government',
      proposedByOrganisation: null,
      status: 'approved',
    },
    {
      id: 'r2',
      type: 'recommendation' as const,
      directedAt: 'federal  government',
      proposedByOrganisation: null,
      status: 'suggested',
    },
  ];
  const link = (
    status: StakeholderLinkView['status'],
    organisation = 'NITDA',
  ): StakeholderLinkView => ({
    id: `l-${status}-${organisation}`,
    target: 'Federal Government',
    organisation,
    status,
    reason: null,
  });

  it('counts a broad target towards an organisation only once the link is confirmed', () => {
    const suggested = mapStakeholders(delegates, calls, [link('suggested')]);
    expect(suggested.byCall.r1).toEqual([]);
    expect(suggested.unmatched).toEqual([
      { target: 'Federal Government', calls: 2 },
    ]);
    expect(suggested.links).toHaveLength(1);

    const confirmed = mapStakeholders(delegates, calls, [link('confirmed')]);
    expect(confirmed.byCall.r1).toEqual([
      'National Information Technology Development Agency (NITDA)',
    ]);
    expect(confirmed.byCall.r2).toEqual(confirmed.byCall.r1);
    expect(confirmed.stakeholders[0]).toMatchObject({ asks: ['r1', 'r2'] });
    expect(confirmed.unmatched).toEqual([]);
  });

  it('leaves rejected links out of the map and the list', () => {
    const map = mapStakeholders(delegates, calls, [link('rejected')]);
    expect(map.byCall.r1).toEqual([]);
    expect(map.links).toEqual([]);
  });
});

describe('stakeholders present, for decks and reports', () => {
  const org = (name: string, delegates: number, speakers = 0) => ({
    name,
    spellings: [name],
    delegates: Array.from({ length: delegates }, (_, i) => ({
      id: `${name}${i}`,
      name: `Person ${i}`,
      title: null,
      email: `p${i}@x.org`,
      admitted: false,
    })),
    speakers: Array.from({ length: speakers }, (_, i) => ({
      id: `${name}-sp${i}`,
      name: `Speaker ${i}`,
      role: null,
    })),
    asks: [],
    commitments: [],
  });
  const map = {
    stakeholders: [
      org('National Information Technology Development Agency (NITDA)', 3, 1),
      org('World Bank', 1),
      org('NCAIR', 2),
      org('Empty Org', 0),
      org('Data Science Nigeria (DSN)', 0, 1),
    ],
    byCall: {
      one: ['World Bank'],
      many: [
        'World Bank',
        'National Information Technology Development Agency (NITDA)',
        'NCAIR',
      ],
      none: [],
      empty: ['Empty Org'],
      stage: ['Data Science Nigeria (DSN)'],
    },
    unmatched: [],
    links: [],
  };

  it('writes the organisations by their abbreviation, busiest first, without naming anyone', () => {
    expect(presentLine(map, 'one')).toBe('World Bank (1 delegate)');
    expect(presentLine(map, 'many')).toBe(
      'NITDA (3 delegates, 1 speaker); NCAIR (2 delegates) and 1 more',
    );
    expect(presentLine(map, 'many')).not.toContain('Person');
    expect(presentLine(map, 'many')).not.toContain('Speaker 0');
  });

  it('counts an organisation that is here only on the programme', () => {
    expect(presentLine(map, 'stage')).toBe('DSN (1 speaker)');
  });

  it('says nothing when nobody from there is at the event', () => {
    expect(presentLine(map, 'none')).toBeNull();
    expect(presentLine(map, 'empty')).toBeNull();
    expect(presentLine(map, 'unknown')).toBeNull();
  });

  it('gives the rapporteur the stakeholders present with each recommendation', () => {
    const prompt = reportPrompt(
      {
        event: 'Build 2026',
        session: 'Compute',
        description: null,
        speakers: [],
        calls: [
          {
            type: 'recommendation',
            action: 'Fund shared compute',
            directedAt: 'Federal Government',
            proposedBy: null,
            deadline: null,
            amount: null,
            stakeholdersPresent: 'NITDA (3 delegates)',
          },
        ],
      },
      'transcript',
    );
    expect(prompt).toContain(
      'Fund shared compute (for: Federal Government; stakeholders at the event: NITDA (3 delegates))',
    );
  });
});
