import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';
import type { CaptionsService } from '../captions/captions.service';
import type { EditionsService } from '../editions/editions.service';
import type { SessionsService } from '../sessions/sessions.service';
import type {
  AnalysisLine,
  AnalysisProvider,
  FoundCallToAction,
} from './analysis/analysis.provider';
import { cleanFound } from './analysis/claude.provider';
import { CallsToActionService } from './calls-to-action.service';
import type { CallToAction } from './entities/call-to-action.entity';
import type { SessionAnalysis } from './entities/session-analysis.entity';

/**
 * Calls to action: Analyse reads only what was said since the last analysis,
 * suggests what it finds, and moves its place on; merging gathers the voices
 * of duplicates into the one kept; nothing analyses without the AI set up.
 */
const EDITION = 'e1';
const SESSION = 's1';
const at = (s: number) => new Date(Date.UTC(2026, 9, 21, 9, 0, s));

function found(over: Partial<FoundCallToAction> = {}): FoundCallToAction {
  return {
    type: 'recommendation',
    action: 'Make disaggregated data mandatory',
    shortText: 'Make disaggregated data mandatory',
    directedAt: 'Federal Government',
    proposedBy: 'Dr Amina Bello',
    proposedByOrganisation: 'NBS',
    deadline: null,
    amount: null,
    theme: 'Data',
    quote: 'Government must make disaggregated data mandatory.',
    line: 2,
    needsDetail: false,
    ...over,
  };
}

function setup(
  opts: {
    configured?: boolean;
    cursor?: Date | null;
    find?: FoundCallToAction[];
    rows?: {
      s: number;
      text: string;
      name?: string | null;
      mic?: number | null;
    }[];
    stored?: Partial<CallToAction>[];
  } = {},
) {
  const saved: Partial<CallToAction>[] = [];
  let analysis: Partial<SessionAnalysis> | null = opts.cursor
    ? { sessionId: SESSION, analysedUpTo: opts.cursor, runs: 1 }
    : null;
  const stored = new Map(
    (opts.stored ?? []).map((c) => [c.id!, { alsoProposedBy: [], ...c }]),
  );
  const calls = {
    find: jest.fn((q: { where: { id?: { _value: string[] } } }) =>
      Promise.resolve(
        q.where.id
          ? q.where.id._value.map((id) => stored.get(id)).filter(Boolean)
          : [],
      ),
    ),
    findOneBy: jest.fn(({ id }: { id: string }) =>
      Promise.resolve(stored.get(id) ?? null),
    ),
    create: jest.fn((v: Partial<CallToAction>) => v),
    save: jest.fn((v: Partial<CallToAction> | Partial<CallToAction>[]) => {
      const list = Array.isArray(v) ? v : [v];
      saved.push(...list);
      return Promise.resolve(v);
    }),
  } as unknown as Repository<CallToAction>;
  const analyses = {
    findOneBy: jest.fn(() => Promise.resolve(analysis)),
    save: jest.fn((v: Partial<SessionAnalysis>) => {
      analysis = v;
      return Promise.resolve(v);
    }),
  } as unknown as Repository<SessionAnalysis>;
  const read: AnalysisLine[][] = [];
  const ai: AnalysisProvider = {
    configured: opts.configured !== false,
    find: jest.fn((lines: AnalysisLine[]) => {
      read.push(lines);
      return Promise.resolve(opts.find ?? []);
    }),
  };
  const rows = (opts.rows ?? []).map((r) => ({
    createdAt: at(r.s),
    text: r.text,
    name: r.name ?? null,
    mic: r.mic ?? null,
    speaker: null,
  }));
  const captions = {
    fullTranscript: jest.fn().mockResolvedValue(rows),
  } as unknown as CaptionsService;
  const sessions = {
    findById: jest.fn().mockResolvedValue({
      id: SESSION,
      editionId: EDITION,
      title: 'Data for inclusion',
      speakers: [{ name: 'Dr Amina Bello', organisation: 'NBS' }],
    }),
  } as unknown as SessionsService;
  const editions = {
    findById: jest.fn().mockResolvedValue({ id: EDITION, name: 'Build 2026' }),
  } as unknown as EditionsService;
  const updates: unknown[] = [];
  const dataSource = {
    query: jest.fn().mockResolvedValue([{ org: 'NBS' }]),
    transaction: jest.fn((fn: (m: unknown) => unknown) =>
      fn({
        save: (v: unknown) => Promise.resolve(v),
        update: (_e: unknown, where: unknown, values: unknown) => {
          updates.push({ where, values });
          return Promise.resolve({});
        },
      }),
    ),
  } as unknown as DataSource;
  const service = new CallsToActionService(
    calls,
    analyses,
    ai,
    captions,
    sessions,
    editions,
    dataSource,
  );
  return { service, saved, read, ai, updates, analysis: () => analysis };
}

describe('calls to action', () => {
  it('suggests what the session asked for, timed by the line it rests on', async () => {
    const { service, saved, read, analysis } = setup({
      rows: [
        { s: 1, text: 'Good morning.', name: 'Moderator' },
        {
          s: 5,
          text: 'Government must make disaggregated data mandatory.',
          name: 'Dr Amina Bello',
        },
        { s: 9, text: 'Thank you.', mic: 3 },
      ],
      find: [found()],
    });
    const result = await service.analyse(SESSION);
    expect(read[0].map((l) => [l.n, l.who])).toEqual([
      [1, 'Moderator'],
      [2, 'Dr Amina Bello'],
      [3, 'Mic 3'],
    ]);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      editionId: EDITION,
      sessionId: SESSION,
      directedAt: 'Federal Government',
      status: 'suggested',
      source: 'ai',
      saidAt: at(5),
    });
    expect(analysis()).toMatchObject({ analysedUpTo: at(9), runs: 1 });
    expect(result.message).toBe('1 call to action suggested from 3 lines.');
  });

  it('reads only what was said since the last analysis', async () => {
    const { service, read } = setup({
      cursor: at(5),
      rows: [
        { s: 1, text: 'old' },
        { s: 5, text: 'old too' },
        { s: 8, text: 'new' },
      ],
    });
    const result = await service.analyse(SESSION);
    expect(read[0].map((l) => l.text)).toEqual(['new']);
    expect(result.message).toBe('No calls to action in the 1 new lines.');
  });

  it('says so when nothing new was said, without asking the AI', async () => {
    const { service, read } = setup({
      cursor: at(9),
      rows: [{ s: 5, text: 'old' }],
    });
    await expect(service.analyse(SESSION)).resolves.toMatchObject({
      read: 0,
      message: 'Nothing new has been said since the last analysis.',
    });
    expect(read).toHaveLength(0);
  });

  it('refuses to analyse until the AI is set up', async () => {
    const { service } = setup({ configured: false });
    await expect(service.analyse(SESSION)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('merges duplicates: their speakers join the one kept, the rest stay on record', async () => {
    const { service, updates } = setup({
      stored: [
        {
          id: 'a',
          editionId: EDITION,
          status: 'approved',
          proposedBy: 'Amina',
          alsoProposedBy: [],
        },
        {
          id: 'b',
          editionId: EDITION,
          status: 'suggested',
          proposedBy: 'Kwame',
          alsoProposedBy: ['Grace'],
        },
        {
          id: 'c',
          editionId: EDITION,
          status: 'suggested',
          proposedBy: 'Amina',
          alsoProposedBy: [],
        },
      ],
    });
    const kept = await service.merge('a', ['b', 'c'], 'staff');
    expect(kept.alsoProposedBy.sort()).toEqual(['Grace', 'Kwame']);
    expect(updates).toEqual([
      {
        where: { id: expect.objectContaining({ _value: ['b', 'c'] }) },
        values: { status: 'merged', mergedInto: 'a', reviewedBy: 'staff' },
      },
    ]);
  });

  it('will not edit one that was merged away', async () => {
    const { service } = setup({
      stored: [
        { id: 'b', editionId: EDITION, status: 'merged', mergedInto: 'a' },
      ],
    });
    await expect(service.update('b', 'staff', { action: 'x' })).rejects.toThrow(
      ConflictException,
    );
  });
});

describe('cleaning what the model found', () => {
  it('drops items missing their action, target or quote, and lines out of range', () => {
    const items = [
      { ...found(), proposedBy: '  ', line: 99 },
      { ...found(), directedAt: ' ' },
      { ...found(), quote: '' },
    ];
    const out = cleanFound(items, 3);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ proposedBy: null, line: 0 });
  });
});
