import {
  cleanReport,
  type RapporteurReportAnswer,
} from './report/rapporteur-report';
import type { ClaudeRapporteurWriter } from './report/rapporteur-writer';
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';
import type { CaptionsService } from '../captions/captions.service';
import type { EditionsService } from '../editions/editions.service';
import type { SessionsService } from '../sessions/sessions.service';
import type {
  AnalysisLine,
  AnalysisProvider,
  FoundCallToAction,
} from './analysis/analysis.provider';
import { cleanFound, quoteLine } from './analysis/claude.provider';
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
    /** What the rapporteur writer answers. */
    report?: { report: RapporteurReportAnswer | null; reason: string | null };
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
    brief: jest.fn().mockResolvedValue({
      text: 'Asked to address gaps in census data.',
      fileName: 'brief.docx',
      updatedAt: null,
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
  const rapporteur = {
    configured: opts.configured !== false,
    write: jest.fn(() =>
      Promise.resolve(opts.report ?? { report: report(), reason: null }),
    ),
  } as unknown as ClaudeRapporteurWriter;
  const service = new CallsToActionService(
    calls,
    analyses,
    ai,
    captions,
    sessions,
    editions,
    dataSource,
    {} as never, // the deck designer: not used here
    {} as never, // storage: not used here
    rapporteur,
  );
  return {
    service,
    saved,
    read,
    ai,
    updates,
    rapporteur,
    analysis: () => analysis,
  };
}

describe('calls to action', () => {
  it('suggests what the session asked for, timed by the line it rests on', async () => {
    const { service, saved, read, ai, analysis } = setup({
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
    // the organisers' brief goes in as context
    expect((ai.find as jest.Mock).mock.calls[0][1]).toMatchObject({
      brief: 'Asked to address gaps in census data.',
    });
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

  it('reads the whole session again when asked to', async () => {
    const { service, read } = setup({
      cursor: at(9),
      rows: [
        { s: 1, text: 'first' },
        { s: 5, text: 'second' },
      ],
    });
    const result = await service.analyse(SESSION, true);
    expect(read[0].map((l) => l.text)).toEqual(['first', 'second']);
    expect(result.message).toBe('No calls to action in the 2 lines.');
  });

  it('says so when nothing new was said, without asking the AI', async () => {
    const { service, read } = setup({
      cursor: at(9),
      rows: [{ s: 5, text: 'old' }],
    });
    await expect(service.analyse(SESSION)).resolves.toMatchObject({
      read: 0,
      message: expect.stringContaining(
        'Nothing new has been said since the last analysis.',
      ) as unknown,
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
  const said = (...texts: string[]): AnalysisLine[] =>
    texts.map((text, i) => ({ n: i + 1, at: at(i), who: null, text }));
  const transcript = said(
    'Good morning everyone.',
    'Government must make disaggregated data mandatory.',
    'Thank you.',
  );

  it('drops items missing their action, target or quote', () => {
    const items = [
      { ...found(), proposedBy: '  ' },
      { ...found(), directedAt: ' ' },
      { ...found(), quote: '' },
    ];
    const out = cleanFound(items, transcript);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ proposedBy: null, line: 2 });
  });

  it('drops a call whose quote nobody said (drawn from the brief, say)', () => {
    const invented = {
      ...found(),
      action: 'Invest in sovereign compute before 2030',
      quote: 'Africa must invest in sovereign compute before 2030.',
      line: 2,
    };
    expect(cleanFound([invented], transcript)).toEqual([]);
  });

  it('keeps a quote with tidied punctuation, or across a caption break', () => {
    const tidied = {
      ...found(),
      quote: 'government MUST make disaggregated data mandatory',
    };
    expect(cleanFound([tidied], transcript)[0]?.line).toBe(2);
    const split = said(
      'We call on the banks',
      'to set aside thirty percent of SME lending for women.',
    );
    const across = {
      ...found(),
      quote:
        'We call on the banks to set aside thirty percent of SME lending for women.',
      line: 1,
    };
    expect(cleanFound([across], split)[0]?.line).toBe(1);
  });

  it('finds the right line when the model cites the wrong one', () => {
    const item = { ...found(), line: 99 };
    expect(cleanFound([item], transcript)[0]?.line).toBe(2);
  });

  it('holds a short quote to the exact words', () => {
    expect(quoteLine('make data mandatory', transcript, 2)).toBeNull();
    expect(quoteLine('Thank you', transcript, 3)).toBe(3);
  });
});

/** A report as the writer answers it. */
function report(
  over: Partial<RapporteurReportAnswer> = {},
): RapporteurReportAnswer {
  return {
    purpose: 'How public data can serve inclusion.',
    attendees: 'Dr Amina Bello (NBS)',
    insights: [
      {
        insight: 'Open data is under-used.',
        whyItMatters: 'Startups cannot build without it.',
        evidence: 'Two datasets cited.',
        implications: 'Publish more.',
      },
    ],
    perspectives: ['Privacy against openness.'],
    opportunities: [],
    challenges: [],
    recommendations: [],
    commitments: [],
    synthesis: 'A focused session on data.',
    ...over,
  };
}

describe('rapporteur report', () => {
  it('writes from the named transcript and the approved calls', async () => {
    const { service, rapporteur } = setup({
      rows: [{ s: 0, text: 'We will publish the census data.', mic: 1 }],
    });
    const out = await service.writeReport(SESSION);
    expect(out.report.purpose).toBe('How public data can serve inclusion.');
    expect(out.event).toBe('Build 2026');
    expect(out.session.title).toBe('Data for inclusion');
    const [brief, transcript] = (rapporteur.write as jest.Mock).mock
      .calls[0] as [unknown, string];
    expect(brief).toMatchObject({
      session: 'Data for inclusion',
      sessionBrief: 'Asked to address gaps in census data.',
      calls: [],
    });
    expect(transcript).toContain('Mic 1: We will publish the census data.');
  });

  it('refuses a session with nothing said, and says why the AI could not answer', async () => {
    await expect(setup().service.writeReport(SESSION)).rejects.toThrow(
      BadRequestException,
    );
    const { service } = setup({
      rows: [{ s: 0, text: 'Hello.' }],
      report: { report: null, reason: 'The AI is busy right now.' },
    });
    await expect(service.writeReport(SESSION)).rejects.toThrow(
      'The AI is busy right now.',
    );
  });

  it('tidies cells, fills the unsaid and drops empty rows', () => {
    const out = cleanReport(
      report({
        attendees: '  ',
        perspectives: ['- One  view', ' ', 'Two', 'Three', 'Four'],
        recommendations: [
          {
            recommendation: 'Fund it',
            owner: '',
            nextStep: 'Draft a bill',
            timeframe: ' ',
          },
          { recommendation: ' ', owner: 'x', nextStep: 'y', timeframe: 'z' },
        ],
      }),
    );
    expect(out.attendees).toBe('Not stated');
    expect(out.perspectives).toEqual(['One view', 'Two', 'Three']);
    expect(out.recommendations).toEqual([
      {
        recommendation: 'Fund it',
        owner: 'Not stated',
        nextStep: 'Draft a bill',
        timeframe: 'Not stated',
      },
    ]);
  });
});
