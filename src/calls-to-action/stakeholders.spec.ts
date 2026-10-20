import {
  mapStakeholders,
  orgAliases,
  sameOrg,
  type StakeholderCall,
  type StakeholderDelegate,
} from './stakeholders';

const same = (a: string, b: string) => sameOrg(orgAliases(a), orgAliases(b));

const delegate = (
  name: string,
  organisation: string,
  admitted = false,
): StakeholderDelegate => ({
  id: name,
  name,
  title: null,
  email: `${name.toLowerCase().replace(/\s+/g, '.')}@x.org`,
  organisation,
  admitted,
});
const call = (
  id: string,
  directedAt: string,
  type: StakeholderCall['type'] = 'recommendation',
  extra: Partial<StakeholderCall> = {},
): StakeholderCall => ({
  id,
  type,
  directedAt,
  proposedByOrganisation: null,
  status: 'approved',
  ...extra,
});

describe('matching organisation names', () => {
  it('ignores case, punctuation and filler words', () => {
    expect(same('Policy Innovation Centre', 'policy innovation centre.')).toBe(
      true,
    );
    expect(same('The World Bank', 'World Bank')).toBe(true);
    expect(
      same(
        'Centre for Journalism, Innovation & Development',
        'Centre for Journalism Innovation and Development',
      ),
    ).toBe(true);
  });

  it('reads an abbreviation in brackets, and a long name’s initials', () => {
    expect(
      same(
        'National Information Technology Development Agency (NITDA)',
        'NITDA',
      ),
    ).toBe(true);
    expect(
      same('National Information Technology Development Agency', 'NITDA'),
    ).toBe(true);
    expect(
      same(
        'Nigerian Economic Summit Group (NESG)',
        'Nigerian Economics Summit Group',
      ),
    ).toBe(true);
  });

  it('keeps different organisations apart', () => {
    expect(same('NITDA', 'NCAIR')).toBe(false);
    expect(same('Tamarind Bank', 'Tamarind Foundation')).toBe(false);
    // three-letter initials alone are too common to trust
    expect(same('Policy Innovation Centre', 'Public Interest Council')).toBe(
      false,
    );
  });
});

describe('mapping stakeholders', () => {
  const delegates = [
    delegate(
      'Ada Eze',
      'National Information Technology Development Agency (NITDA)',
      true,
    ),
    delegate('Bayo Ade', 'NITDA'),
    delegate('Chi Obi', 'NCAIR', true),
    delegate('Dami Ola', 'World Bank'),
  ];

  it('groups an organisation’s spellings and lists its delegates, checked-in first', () => {
    const { stakeholders } = mapStakeholders(delegates, []);
    const nitda = stakeholders.find((s) => s.spellings.includes('NITDA'))!;
    expect(nitda.spellings).toHaveLength(2);
    expect(nitda.delegates.map((d) => d.name)).toEqual(['Ada Eze', 'Bayo Ade']);
    expect(nitda.delegates[0]).not.toHaveProperty('organisation');
  });

  it('files recommendations as asks and pledges as commitments', () => {
    const map = mapStakeholders(delegates, [
      call('r1', 'NITDA'),
      call('r2', 'NITDA and NCAIR'),
      call('p1', 'NCAIR', 'pledge'),
      call('p2', 'Our partners', 'pledge', {
        proposedByOrganisation: 'World Bank',
      }),
      call('r3', 'Federal Government'),
      call('r4', 'Federal Government'),
      call('x', 'NITDA', 'recommendation', { status: 'rejected' }),
    ]);
    const by = (n: string) =>
      map.stakeholders.find((s) => s.spellings.includes(n))!;
    expect(by('NITDA')).toMatchObject({ asks: ['r1', 'r2'], commitments: [] });
    expect(by('NCAIR')).toMatchObject({ asks: ['r2'], commitments: ['p1'] });
    expect(by('World Bank')).toMatchObject({ asks: [], commitments: ['p2'] });
    expect(map.byCall.r2).toHaveLength(2);
    expect(map.byCall).not.toHaveProperty('x');
    expect(map.unmatched).toEqual([{ target: 'Federal Government', calls: 2 }]);
  });

  it('puts the organisations with the most asks first', () => {
    const map = mapStakeholders(delegates, [
      call('r1', 'World Bank'),
      call('r2', 'World Bank'),
      call('r3', 'NCAIR'),
    ]);
    expect(map.stakeholders.map((s) => s.name).slice(0, 2)).toEqual([
      'World Bank',
      'NCAIR',
    ]);
  });
});
