import type { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import type { Repository } from 'typeorm';
import type { TranscriptSegment } from '../../captions/entities/transcript-segment.entity';
import type { RealtimeService } from '../../common/realtime/realtime.service';
import type { SessionsService } from '../../sessions/sessions.service';
import { lagosMidnight, SessionSwitchService } from './session-switch.service';
import type { SwitchAnswer } from './switch-detector';
import type { ClaudeSwitchSuggester } from './switch-suggester';
import type { SwitchSuggestion } from './switch-suggestion.entity';

const at = (hm: string) => new Date(`2026-10-22T${hm}:00+01:00`);

/** Just the Redis the service uses, on a clock the test moves. */
class ClockRedis {
  now = at('11:00').getTime();
  private store = new Map<string, { v: string; until?: number }>();
  private alive(k: string) {
    const e = this.store.get(k);
    if (e?.until !== undefined && e.until <= this.now) this.store.delete(k);
    return this.store.get(k);
  }
  set(k: string, v: string, px: 'PX', ms: number, nx: 'NX') {
    void px;
    if (nx && this.alive(k)) return Promise.resolve(null);
    this.store.set(k, { v, until: this.now + ms });
    return Promise.resolve('OK');
  }
  incr(k: string) {
    const n = Number(this.alive(k)?.v ?? 0) + 1;
    this.store.set(k, { v: String(n) });
    return Promise.resolve(n);
  }
  expire() {
    return Promise.resolve(1);
  }
}

function setup(
  opts: {
    enabled?: boolean;
    cap?: number;
    captions?: string[];
    answer?: SwitchAnswer | null;
    status?: { lecture?: string; panel?: string };
  } = {},
) {
  const rows: SwitchSuggestion[] = [];
  const matches = (s: SwitchSuggestion, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) =>
      v && typeof v === 'object' && '_value' in v
        ? (s[k as keyof SwitchSuggestion] as Date | null)! >=
          (v as { _value: Date })._value
        : s[k as keyof SwitchSuggestion] === v,
    );
  const suggestions = {
    find: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(rows.filter((s) => matches(s, where))),
    ),
    count: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(rows.filter((s) => matches(s, where)).length),
    ),
    findOneBy: jest.fn(({ id }: { id: string }) =>
      Promise.resolve(rows.find((s) => s.id === id) ?? null),
    ),
    create: (s: Partial<SwitchSuggestion>) => s,
    save: jest.fn((s: SwitchSuggestion) => {
      rows.push({
        ...s,
        id: `s${rows.length + 1}`,
        createdAt: new Date(redis.now),
        decidedAt: null,
      });
      return Promise.resolve(s);
    }),
    update: jest.fn((id: string, change: Partial<SwitchSuggestion>) => {
      Object.assign(
        rows.find((s) => s.id === id)!,
        change,
      );
      return Promise.resolve({});
    }),
  } as unknown as Repository<SwitchSuggestion>;
  const redis = new ClockRedis();
  const captions = opts.captions ?? [
    'Thank you Professor for that lecture.',
    'And now our next session.',
    'Please welcome our panel, Dr. Okolo, Dr. Ajala and our moderator Dr. Adekanmbi.',
  ];
  const segments = {
    find: jest.fn(() =>
      Promise.resolve(
        captions.map((text, i) => ({
          text,
          createdAt: new Date(redis.now - (captions.length - i) * 20_000),
        })),
      ),
    ),
  } as unknown as Repository<TranscriptSegment>;
  const board = () => [
    {
      id: 'lecture',
      title: 'What Africa Stands to Lose',
      day: 2,
      startsAt: at('10:30'),
      endsAt: at('10:50'),
      room: 'Main Hall',
      status: opts.status?.lecture ?? 'live',
      speakers: [],
    },
    {
      id: 'panel',
      title: 'From Potential to Progress',
      day: 2,
      startsAt: at('11:00'),
      endsAt: at('11:30'),
      room: 'Main Hall',
      status: opts.status?.panel ?? 'scheduled',
      speakers: [{ name: 'Dr. Chinasa Okolo' }, { name: 'Dr. Olubunmi Ajala' }],
    },
  ];
  const sessions = {
    board: jest.fn(() => Promise.resolve(board())),
  } as unknown as SessionsService;
  const emitGlobal = jest.fn();
  const realtime = { emitGlobal } as unknown as RealtimeService;
  const judge = jest.fn(() =>
    Promise.resolve(
      opts.answer === undefined
        ? {
            verdict: 'next_started',
            confidence: 0.92,
            evidence: 'Please welcome our panel, Dr. Okolo, Dr. Ajala',
            reason: 'The panel was introduced.',
          }
        : opts.answer,
    ),
  );
  const suggester = {
    configured: true,
    judge,
  } as unknown as ClaudeSwitchSuggester;
  const config = {
    get: (k: string) =>
      k === 'SESSION_SWITCH_SUGGESTIONS'
        ? opts.enabled === false
          ? undefined
          : 'on'
        : k === 'SESSION_SWITCH_DAILY_CAP'
          ? opts.cap
          : undefined,
  } as unknown as ConfigService;
  const service = new SessionSwitchService(
    config,
    suggestions,
    segments,
    redis as unknown as Redis,
    sessions,
    realtime,
    suggester,
  );
  const tick = async (minutesLater = 0) => {
    redis.now += minutesLater * 60_000;
    await service.tick(new Date(redis.now));
  };
  return { service, rows, redis, tick, judge, emitGlobal, opts };
}

describe('switch suggestions', () => {
  it('suggests starting the next session when its speakers are introduced', async () => {
    const { rows, tick, emitGlobal } = setup();
    await tick();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      room: 'Main Hall',
      kind: 'start_next',
      fromSessionId: 'lecture',
      toSessionId: 'panel',
      status: 'open',
    });
    expect(emitGlobal).toHaveBeenCalledWith('switch:suggestions', {
      room: 'Main Hall',
    });
  });

  it('does not ask Claude without a cue, outside a changeover, or while a suggestion waits', async () => {
    const quiet = setup({
      captions: [
        'Compute capacity remains limited.',
        'Data centres need power.',
        'Costs keep rising.',
      ],
    });
    await quiet.tick();
    expect(quiet.judge).not.toHaveBeenCalled();

    const early = setup();
    early.redis.now = at('10:35').getTime();
    await early.tick();
    expect(early.judge).not.toHaveBeenCalled();

    const waiting = setup();
    await waiting.tick();
    await waiting.tick(1);
    expect(waiting.judge).toHaveBeenCalledTimes(1);
  });

  it('asks at most once per room in two minutes, and stops at the daily cap', async () => {
    const { tick, judge } = setup({
      answer: { verdict: 'neither', confidence: 0.2, evidence: '', reason: '' },
    });
    await tick();
    await tick(0.5);
    await tick(0.5);
    expect(judge).toHaveBeenCalledTimes(1);
    await tick(2);
    expect(judge).toHaveBeenCalledTimes(2);

    const capped = setup({
      cap: 1,
      answer: { verdict: 'neither', confidence: 0.2, evidence: '', reason: '' },
    });
    await capped.tick();
    await capped.tick(3);
    expect(capped.judge).toHaveBeenCalledTimes(1);
  });

  it('counts a suggestion right when the room switches that way, even without a tap', async () => {
    const run = setup();
    await run.tick();
    run.opts.status = { lecture: 'completed', panel: 'live' };
    await run.tick(1);
    expect(run.rows[0].status).toBe('matched');
    const list = await run.service.list(new Date(run.redis.now));
    expect(list.today).toEqual({ right: 1, wrong: 0, unanswered: 0 });
  });

  it('records "not yet" as wrong, and does not repeat it for ten minutes', async () => {
    const run = setup();
    await run.tick();
    await run.service.decide(
      run.rows[0].id,
      'dismissed',
      new Date(run.redis.now),
    );
    await run.tick(3);
    expect(run.rows).toHaveLength(1);
    await run.tick(10);
    expect(run.rows).toHaveLength(2);
    expect((await run.service.list(new Date(run.redis.now))).today.wrong).toBe(
      1,
    );
  });

  it('puts away a suggestion nobody answers', async () => {
    const run = setup();
    await run.tick();
    await run.tick(21);
    expect(run.rows[0].status).toBe('expired');
  });

  it('does nothing when switched off, and says so', async () => {
    const run = setup({ enabled: false });
    run.service.onModuleInit();
    expect((await run.service.list()).enabled).toBe(false);
  });

  it('counts the day from midnight in Lagos', () => {
    expect(lagosMidnight(new Date('2026-10-21T23:30:00Z')).toISOString()).toBe(
      '2026-10-21T23:00:00.000Z',
    );
    expect(lagosMidnight(new Date('2026-10-22T10:00:00Z')).toISOString()).toBe(
      '2026-10-21T23:00:00.000Z',
    );
  });
});
