import { lagosClock, minutesOf, splitFixes } from './nightly-tidy';
import { NightlyTidyService } from './nightly-tidy.service';

const fix = (over: object = {}) => ({
  fromSessionId: 'qa',
  toSessionId: 'panel',
  since: '2026-10-22T11:58:00.000Z',
  until: '2026-10-22T12:31:00.000Z',
  lines: 500,
  confidence: 0.95,
  namesHeard: [],
  evidence: 'Please welcome our panel',
  reason: 'The panel is introduced.',
  ...over,
});

function build() {
  const store = new Map<string, string>();
  const redis = {
    set: jest.fn((k: string, v: string, ...rest: unknown[]) => {
      if (rest.includes('NX') && store.has(k)) return Promise.resolve(null);
      store.set(k, v);
      return Promise.resolve('OK');
    }),
    get: jest.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
    del: jest.fn(),
  };
  const dataSource = {
    query: jest.fn((sql: string) => {
      if (sql.includes('"isCurrent"')) return Promise.resolve([{ id: 'e1' }]);
      if (sql.includes('GROUP BY day')) return Promise.resolve([{ day: 2 }]);
      if (sql.includes('DISTINCT TRIM(room)'))
        return Promise.resolve([{ room: 'Main Hall' }]);
      return Promise.resolve([{ id: 'qa' }, { id: 'panel' }]);
    }),
  };
  const agenda = {
    run: jest.fn().mockResolvedValue({
      fixes: [fix(), fix({ confidence: 0.6, since: 'b' })],
    }),
  };
  const captions = {
    moveCaptions: jest.fn().mockResolvedValue({ moved: 500, calls: 2 }),
  };
  const names = {
    runReview: jest.fn().mockResolvedValue({ added: 3, changed: 0 }),
  };
  const calls = {
    analyse: jest.fn().mockResolvedValue({ added: [{}, {}] }),
    fillWhoSaid: jest.fn().mockResolvedValue({ filled: 4, missing: 0 }),
  };
  const config = { get: () => undefined };
  const service = new NightlyTidyService(
    config as never,
    dataSource as never,
    agenda as never,
    captions as never,
    names as never,
    calls as never,
    redis as never,
  );
  return { service, captions, calls, names, agenda, redis };
}

describe('the overnight tidy', () => {
  it('reads Abuja time and the hour it runs at', () => {
    expect(lagosClock(new Date('2026-10-22T22:30:00Z'))).toEqual({
      date: '2026-10-22',
      minutes: 23 * 60 + 30,
    });
    expect(lagosClock(new Date('2026-10-22T23:30:00Z')).date).toBe(
      '2026-10-23',
    );
    expect(minutesOf('22:15')).toBe(22 * 60 + 15);
    expect(minutesOf('nonsense')).toBe(23 * 60);
  });

  it('moves only sure findings that name where the lines go', () => {
    const { auto, review } = splitFixes([
      fix(),
      fix({ confidence: 0.7 }),
      fix({ toSessionId: null }),
    ] as never);
    expect(auto).toHaveLength(1);
    expect(review).toHaveLength(2);
  });

  it('waits for its hour, runs once a night, and does every step', async () => {
    const t = build();
    await t.service.tick(new Date('2026-10-22T20:00:00Z')); // 21:00 in Abuja
    expect(t.agenda.run).not.toHaveBeenCalled();
    await t.service.tick(new Date('2026-10-22T22:05:00Z')); // 23:05
    await t.service.tick(new Date('2026-10-22T22:10:00Z')); // again: already done
    expect(t.agenda.run).toHaveBeenCalledTimes(1);
    expect(t.captions.moveCaptions).toHaveBeenCalledTimes(1);
    expect(t.names.runReview).toHaveBeenCalledTimes(2);
    // the moved sessions read afresh
    expect(t.calls.analyse).toHaveBeenCalledWith('qa', true);
    const result = await t.service.result('e1', 2);
    expect(result).toMatchObject({
      day: 2,
      namesAdded: 6,
      newSuggestions: 4,
      speakersFilled: 8,
    });
    expect(result!.moved).toHaveLength(1);
    expect(result!.toReview).toHaveLength(1);
    expect(result!.finishedAt).not.toBeNull();
  });
});
