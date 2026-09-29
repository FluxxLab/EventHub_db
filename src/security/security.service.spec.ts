import { FindOperator } from 'typeorm';
import { EventSeverity, SecurityEvent } from './entities/security-event.entity';
import { SecurityService } from './security.service';

const event = (over: Partial<SecurityEvent>): SecurityEvent => ({
  id: 'e',
  type: 'session_deleted',
  description: 'Session deleted',
  actionId: null,
  severity: EventSeverity.WARNING,
  metadata: null,
  createdAt: new Date('2027-09-08T10:00:00Z'),
  ...over,
});

function build(rows: SecurityEvent[]) {
  const events = {
    find: jest.fn().mockResolvedValue(rows),
    create: jest.fn((v: unknown) => v),
    save: jest.fn().mockResolvedValue({}),
  };
  const people = {
    find: jest.fn().mockResolvedValue([
      {
        id: 'a1',
        name: 'Amina Yusuf',
        email: 'amina@pic.org.ng',
        accessTier: 'admin',
      },
    ]),
  };
  const service = new SecurityService(events as never, people as never);
  return { service, events, people };
}

describe('SecurityService.list', () => {
  it('names who did each thing, with one lookup for the page', async () => {
    const t = build([
      event({ id: '1', actionId: 'a1' }),
      event({ id: '2', actionId: 'a1' }),
      event({ id: '3', actionId: 'gone' }),
      event({ id: '4', actionId: null }),
    ]);
    const rows = await t.service.list({});
    expect(t.people.find).toHaveBeenCalledTimes(1);
    expect(rows.map((r) => r.actor?.name ?? null)).toEqual([
      'Amina Yusuf',
      'Amina Yusuf',
      null, // the account was deleted
      null, // a gate scan: no one signed in
    ]);
    expect(rows[0].actor).toEqual({
      id: 'a1',
      name: 'Amina Yusuf',
      email: 'amina@pic.org.ng',
      tier: 'admin',
    });
  });

  it('skips the lookup when no row has an actor', async () => {
    const t = build([event({ actionId: null })]);
    await t.service.list({});
    expect(t.people.find).not.toHaveBeenCalled();
  });

  it('filters by types, person and a date window, newest first', async () => {
    const t = build([]);
    await t.service.list({
      types: ['session_deleted', 'tier_changed'],
      actorId: 'a1',
      from: '2027-09-01T00:00:00Z',
      before: '2027-09-09T00:00:00Z',
      limit: 20,
    });
    const [{ where, order, take }] = t.events.find.mock.calls[0] as [
      {
        where: Record<string, unknown>;
        order: unknown;
        take: number;
      },
    ];
    expect((where.type as FindOperator<string[]>).value).toEqual([
      'session_deleted',
      'tier_changed',
    ]);
    expect(where.actionId).toBe('a1');
    expect((where.createdAt as FindOperator<unknown>).type).toBe('and');
    expect(order).toEqual({ createdAt: 'DESC' });
    expect(take).toBe(20);
  });
});
