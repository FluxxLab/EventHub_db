import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Not, Repository } from 'typeorm';
import { CaptionsService } from '../captions/captions.service';
import { StorageService } from '../common/storage/storage.service';
import { EditionsService } from '../editions/editions.service';
import { SessionsService } from '../sessions/sessions.service';
import {
  ANALYSIS_PROVIDER,
  type AnalysisLine,
  type AnalysisProvider,
} from './analysis/analysis.provider';
import type {
  CreateCallToActionDto,
  SaveCallToActionDto,
} from './dto/calls-to-action.dto';
import { CallToAction } from './entities/call-to-action.entity';
import { SessionAnalysis } from './entities/session-analysis.entity';
import { cleanDesign, type DeckDesign } from './deck/deck-design';
import { ClaudeDeckDesigner, type DeckImage } from './deck/deck-designer';
import { cleanReport } from './report/rapporteur-report';
import { ClaudeRapporteurWriter } from './report/rapporteur-writer';

/** Images larger than this are not shown to Claude (its limit is 5 MB). */
const MAX_IMAGE_BYTES = 3_500_000;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** Brand guides larger than this are not sent (Claude reads PDFs up to 32 MB). */
const MAX_GUIDE_BYTES = 24_000_000;

/** "8 – 9 Sept 2026", as the deck's cover shows the dates. */
export function deckDates(startsAt: Date, endsAt: Date): string {
  const day = (d: Date) => d.getUTCDate();
  const month = (d: Date) =>
    d
      .toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })
      .replace(/^Sep$/, 'Sept');
  const year = (d: Date) => d.getUTCFullYear();
  if (year(startsAt) !== year(endsAt))
    return `${day(startsAt)} ${month(startsAt)} ${year(startsAt)} – ${day(endsAt)} ${month(endsAt)} ${year(endsAt)}`;
  if (month(startsAt) !== month(endsAt))
    return `${day(startsAt)} ${month(startsAt)} – ${day(endsAt)} ${month(endsAt)} ${year(endsAt)}`;
  return day(startsAt) === day(endsAt)
    ? `${day(startsAt)} ${month(startsAt)} ${year(startsAt)}`
    : `${day(startsAt)} – ${day(endsAt)} ${month(endsAt)} ${year(endsAt)}`;
}

/** Who calls to action are usually directed at, before the event's own agencies are known. */
export const DEFAULT_TARGETS = [
  'Federal Government',
  'State governments',
  'National Assembly',
  'Private sector',
  'Financial institutions',
  'Civil society organisations',
  'Development partners',
  'Academia',
  'Media',
];

/** A session's transcript is read whole, up to this many lines (several hours). */
const MAX_LINES = 6000;

/** "Dr Amina Bello", "Mic 2", "Speaker 1" or null: who said a line, as the console shows it. */
const whoSaid = (r: {
  name: string | null;
  mic: number | null;
  speaker: number | null;
}): string | null =>
  r.name ??
  (r.mic !== null
    ? `Mic ${r.mic}`
    : r.speaker !== null
      ? `Speaker ${r.speaker + 1}`
      : null);

/**
 * Calls to action drawn from the summit's sessions: suggested by the analysis
 * of each session's named transcript (Analyse, at a break or at the end), then
 * reviewed by organisers - edited, merged, approved or rejected - before the
 * approved ones go into the call-to-action deck.
 */
@Injectable()
export class CallsToActionService {
  /** Sessions being analysed on this instance: one at a time each. */
  private readonly running = new Set<string>();

  constructor(
    @InjectRepository(CallToAction)
    private readonly calls: Repository<CallToAction>,
    @InjectRepository(SessionAnalysis)
    private readonly analyses: Repository<SessionAnalysis>,
    @Inject(ANALYSIS_PROVIDER) private readonly ai: AnalysisProvider,
    private readonly captions: CaptionsService,
    private readonly sessions: SessionsService,
    private readonly editions: EditionsService,
    private readonly dataSource: DataSource,
    private readonly designer: ClaudeDeckDesigner,
    private readonly storage: StorageService,
    private readonly rapporteur: ClaudeRapporteurWriter,
  ) {}

  /**
   * The session's rapporteur report, written by Claude from its whole named
   * transcript and its approved calls to action, for the console to fill into
   * the Word template. With the session's details for the report's header.
   */
  async writeReport(sessionId: string) {
    if (!this.rapporteur.configured) {
      throw new ServiceUnavailableException(
        "AI reports aren't set up yet. Ask your administrator.",
      );
    }
    const session = await this.sessions.findById(sessionId);
    if (!session.editionId) {
      throw new BadRequestException('This session belongs to no event.');
    }
    const edition = await this.editions.findById(session.editionId);
    const rows = (await this.captions.fullTranscript(sessionId, 'en')).slice(
      -MAX_LINES,
    );
    if (rows.length === 0) {
      throw new BadRequestException(
        'This session has no captions yet, so there is nothing to report on.',
      );
    }
    const time = (d: Date) => d.toISOString().slice(11, 19);
    const transcript = rows
      .map((r) => `${time(r.createdAt)} ${whoSaid(r) ?? 'Unknown'}: ${r.text}`)
      .join('\n');
    const approved = await this.calls.find({
      where: { sessionId, status: 'approved' },
      order: { createdAt: 'ASC' },
    });
    const { report, reason } = await this.rapporteur.write(
      {
        event: edition.name,
        session: session.title,
        description: session.description?.trim() || null,
        sessionBrief: (await this.sessions.brief(sessionId)).text,
        speakers: (session.speakers ?? []).map((s) =>
          s.organisation ? `${s.name} (${s.organisation})` : s.name,
        ),
        calls: approved.map((c) => ({
          type: c.type,
          action: c.action,
          directedAt: c.directedAt,
          proposedBy: c.proposedBy,
          deadline: c.deadline,
          amount: c.amount,
        })),
      },
      transcript,
    );
    if (!report) throw new ServiceUnavailableException(reason);
    return {
      report: cleanReport(report),
      event: edition.name,
      session: {
        title: session.title,
        startsAt: session.startsAt,
        endsAt: session.endsAt,
        room: session.room ?? null,
      },
      read: rows.length,
    };
  }

  /**
   * A fresh design for the event's call-to-action deck: Claude reads the
   * event's brand colour, logo, cover and approved calls and answers with
   * palette, layouts, shapes and sections. The logo and cover come back too,
   * for the console to place. `design` is null when Claude is not set up or
   * cannot answer; the console then draws the deck in the event's colours.
   */
  async designDeck(
    editionId: string,
    scope: { sessionId?: string; day?: number },
  ): Promise<{
    design: DeckDesign | null;
    reason: string | null;
    brandColor: string | null;
    logo: DeckImage | null;
    logoDark: DeckImage | null;
    cover: DeckImage | null;
    /** Whether the event's brand guide was read for this design. */
    guided: boolean;
  }> {
    if (!scope.sessionId === !scope.day) {
      throw new BadRequestException(
        'Choose one session (a single slide) or one day (the full deck).',
      );
    }
    const edition = await this.editions.findById(editionId);
    const all = await this.calls.find({
      where: {
        editionId,
        status: 'approved',
        ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
      },
      order: { saidAt: 'ASC', createdAt: 'ASC' },
    });
    const sessionsOf = new Map<string, { title: string; day: number }>();
    for (const id of new Set(all.map((c) => c.sessionId))) {
      if (!id) continue;
      const session = await this.sessions.findById(id).catch(() => null);
      if (session)
        sessionsOf.set(id, { title: session.title, day: session.day });
    }
    const approved = scope.day
      ? all.filter(
          (c) => c.sessionId && sessionsOf.get(c.sessionId)?.day === scope.day,
        )
      : all;
    if (approved.length === 0) {
      throw new BadRequestException(
        scope.sessionId
          ? 'This session has no approved calls to action yet.'
          : `Day ${scope.day} has no approved calls to action yet.`,
      );
    }
    const [logo, logoDark, cover, guide] = await Promise.all([
      this.image(edition.logoImage, 'logo'),
      this.image(edition.logoDarkImage, 'logo for dark backgrounds'),
      this.image(edition.coverImage, 'cover'),
      this.pdf(edition.brandGuide),
    ]);
    const { answer, reason } = await this.designer.design(
      {
        event: {
          name: edition.name,
          shortName: edition.shortName,
          when: deckDates(new Date(edition.startsAt), new Date(edition.endsAt)),
          where: edition.city ?? edition.venue,
        },
        brandColor: edition.brandColor,
        scope: scope.sessionId
          ? {
              kind: 'session',
              title: sessionsOf.get(scope.sessionId)?.title ?? 'This session',
            }
          : { kind: 'day', day: scope.day! },
        calls: approved.map((c) => ({
          id: c.id,
          type: c.type,
          shortText: c.shortText,
          directedAt: c.directedAt,
          proposedBy: c.proposedBy,
          theme: c.theme,
          session:
            (c.sessionId && sessionsOf.get(c.sessionId)?.title) || 'No session',
        })),
      },
      [logo, logoDark, cover].filter(
        (i): i is DeckImage => !!i && i.data.length * 0.75 <= MAX_IMAGE_BYTES,
      ),
      guide,
    );
    return {
      design: answer
        ? cleanDesign(
            answer,
            approved.map((c) => c.id),
            edition.brandColor,
          )
        : null,
      reason,
      brandColor: edition.brandColor,
      logo,
      logoDark,
      cover,
      guided: !!guide && !!answer,
    };
  }

  /** The event's brand guide as base64, or null when there is none, it is too large, or it cannot be read. */
  private async pdf(stored: string | null): Promise<string | null> {
    try {
      const url = await this.storage.resolveStoredUrl(stored);
      if (!url) return null;
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      const type = res.headers.get('content-type')?.split(';')[0].trim() ?? '';
      if (!res.ok || type !== 'application/pdf') return null;
      const bytes = Buffer.from(await res.arrayBuffer());
      return bytes.length <= MAX_GUIDE_BYTES ? bytes.toString('base64') : null;
    } catch {
      return null;
    }
  }

  /** A stored image as base64, or null when there is none or it cannot be read. */
  private async image(
    stored: string | null,
    label: DeckImage['label'],
  ): Promise<DeckImage | null> {
    try {
      const url = await this.storage.resolveStoredUrl(stored);
      if (!url) return null;
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      const type = res.headers.get('content-type')?.split(';')[0].trim() ?? '';
      if (!res.ok || !IMAGE_TYPES.includes(type)) return null;
      const data = Buffer.from(await res.arrayBuffer()).toString('base64');
      return { label, mediaType: type as DeckImage['mediaType'], data };
    } catch {
      return null;
    }
  }

  /**
   * The event's logos as images, for the template decks the console draws
   * itself (cards or a table): fetched here because storage does not serve
   * the console's origin. Either is null when the event has none.
   */
  async deckImages(editionId: string) {
    const edition = await this.editions.findById(editionId);
    const [logo, logoDark] = await Promise.all([
      this.image(edition.logoImage, 'logo'),
      this.image(edition.logoDarkImage, 'logo for dark backgrounds'),
    ]);
    return { logo, logoDark };
  }

  /** The event's calls to action, with where each session's analysis has got to. */
  async list(editionId: string) {
    await this.editions.findById(editionId);
    const items = await this.calls.find({
      where: { editionId },
      order: { createdAt: 'ASC' },
    });
    const analyses = await this.dataSource.query<
      { sessionId: string; analysedUpTo: Date; runs: number }[]
    >(
      `SELECT a."sessionId", a."analysedUpTo", a.runs
       FROM session_analyses a JOIN sessions s ON s.id = a."sessionId"
       WHERE s."editionId" = $1`,
      [editionId],
    );
    return { aiReady: this.ai.configured, items, analyses };
  }

  /**
   * Who a call may be directed at: the usual groups, the organisations of the
   * event's ticket holders and speakers, and any already used, once each.
   */
  async targets(editionId: string): Promise<string[]> {
    const rows = await this.dataSource.query<{ org: string }[]>(
      `SELECT DISTINCT TRIM(d.organisation) AS org
         FROM tickets t JOIN delegates d ON d.id = t."delegateId"
        WHERE t."editionId" = $1 AND COALESCE(TRIM(d.organisation), '') <> ''
       UNION
       SELECT DISTINCT TRIM(sp.organisation)
         FROM sessions s
         JOIN session_speakers ss ON ss."sessionsId" = s.id
         JOIN speakers sp ON sp.id = ss."speakersId"
        WHERE s."editionId" = $1 AND COALESCE(TRIM(sp.organisation), '') <> ''
       UNION
       SELECT DISTINCT c."directedAt" FROM calls_to_action c WHERE c."editionId" = $1`,
      [editionId],
    );
    const seen = new Map<string, string>();
    for (const name of [...DEFAULT_TARGETS, ...rows.map((r) => r.org)]) {
      const key = name.trim().toLowerCase();
      if (key && !seen.has(key)) seen.set(key, name.trim());
    }
    return [...seen.values()];
  }

  /**
   * Reads what the session has said since its last analysis and suggests its
   * calls to action. Nothing new since then is not an error: it says so.
   */
  /**
   * Reads what the session has said since its last analysis, or with
   * `fromStart` the whole session again (to retry after editing the mics or
   * the vocabulary, or to test). Calls already on the board are not
   * suggested twice either way.
   */
  async analyse(sessionId: string, fromStart = false) {
    if (!this.ai.configured) {
      throw new ServiceUnavailableException(
        'AI analysis is not set up yet: add ANTHROPIC_API_KEY on the server.',
      );
    }
    if (this.running.has(sessionId)) {
      throw new ConflictException(
        'This session is already being analysed. It takes a minute or two.',
      );
    }
    this.running.add(sessionId);
    try {
      const session = await this.sessions.findById(sessionId);
      if (!session.editionId) {
        throw new BadRequestException('This session belongs to no event.');
      }
      const edition = await this.editions.findById(session.editionId);
      const cursor = await this.analyses.findOneBy({ sessionId });
      const rows = (await this.captions.fullTranscript(sessionId, 'en')).filter(
        (r) => fromStart || !cursor || r.createdAt > cursor.analysedUpTo,
      );
      if (rows.length === 0) {
        return {
          added: [] as CallToAction[],
          read: 0,
          message:
            cursor && !fromStart
              ? 'Nothing new has been said since the last analysis. To read it all again, tick "Read the whole session again".'
              : 'This session has no captions yet.',
        };
      }
      const recent = rows.slice(-MAX_LINES);
      const lines: AnalysisLine[] = recent.map((r, i) => ({
        n: i + 1,
        at: r.createdAt,
        who: whoSaid(r),
        text: r.text,
      }));
      const recorded = await this.calls.find({
        where: { sessionId, status: Not('rejected') },
        select: { shortText: true },
      });
      const found = await this.ai.find(lines, {
        event: edition.name,
        session: session.title,
        speakers: (session.speakers ?? []).map((s) =>
          s.organisation ? `${s.name} (${s.organisation})` : s.name,
        ),
        targets: await this.targets(session.editionId),
        alreadyRecorded: recorded.map((r) => r.shortText),
        brief: (await this.sessions.brief(sessionId)).text,
      });
      const added = found.length
        ? await this.calls.save(
            found.map((f) =>
              this.calls.create({
                editionId: session.editionId!,
                sessionId,
                type: f.type,
                action: f.action,
                shortText: f.shortText,
                directedAt: f.directedAt,
                proposedBy: f.proposedBy,
                proposedByOrganisation: f.proposedByOrganisation,
                deadline: f.deadline,
                amount: f.amount,
                theme: f.theme,
                quote: f.quote,
                saidAt: f.line ? lines[f.line - 1].at : null,
                needsDetail: f.needsDetail,
                status: 'suggested',
                source: 'ai',
              }),
            ),
          )
        : [];
      await this.analyses.save({
        sessionId,
        analysedUpTo: recent.at(-1)!.createdAt,
        runs: (cursor?.runs ?? 0) + 1,
      });
      return {
        added,
        read: lines.length,
        message: added.length
          ? `${added.length} ${added.length === 1 ? 'call to action' : 'calls to action'} suggested from ${lines.length} lines.`
          : `No calls to action in the ${lines.length} ${fromStart ? '' : 'new '}lines.`,
      };
    } finally {
      this.running.delete(sessionId);
    }
  }

  /** One added by hand: approved straight away, since a person wrote it. */
  async create(editionId: string, staffId: string, dto: CreateCallToActionDto) {
    await this.editions.findById(editionId);
    if (!dto.action?.trim() || !dto.directedAt?.trim()) {
      throw new BadRequestException(
        'Say what should be done and who is called on to do it.',
      );
    }
    if (dto.sessionId) {
      const session = await this.sessions.findById(dto.sessionId);
      if (session.editionId !== editionId) {
        throw new BadRequestException('That session is not in this event.');
      }
    }
    return this.calls.save(
      this.calls.create({
        ...this.fields(dto),
        editionId,
        sessionId: dto.sessionId ?? null,
        action: dto.action.trim(),
        shortText: (dto.shortText ?? dto.action).trim().slice(0, 200),
        directedAt: dto.directedAt.trim(),
        status: dto.status ?? 'approved',
        source: 'manual',
        reviewedBy: staffId,
      }),
    );
  }

  /** A reviewer's change: any field, or the status (approve, reject, back to suggested). */
  async update(id: string, staffId: string, dto: SaveCallToActionDto) {
    const call = await this.one(id);
    if (call.status === 'merged') {
      throw new ConflictException(
        'This one was merged into another. Edit that one instead.',
      );
    }
    Object.assign(call, this.fields(dto), {
      ...(dto.status ? { status: dto.status } : {}),
      reviewedBy: staffId,
    });
    return this.calls.save(call);
  }

  /**
   * Folds duplicates into one: the others are kept on record as merged, and
   * their speakers join the one kept, so the slide can say how many asked.
   */
  async merge(into: string, ids: string[], staffId: string) {
    const target = await this.one(into);
    if (target.status === 'merged') {
      throw new ConflictException(
        'Merge into one that has not itself been merged.',
      );
    }
    const others = await this.calls.find({
      where: { id: In(ids.filter((id) => id !== into)) },
    });
    if (others.length === 0) {
      throw new BadRequestException('Choose at least one other to merge.');
    }
    if (others.some((o) => o.editionId !== target.editionId)) {
      throw new BadRequestException(
        'Only calls to action from one event can be merged.',
      );
    }
    const voices = new Set(target.alsoProposedBy);
    for (const o of others) {
      for (const name of [o.proposedBy, ...o.alsoProposedBy]) {
        if (name && name !== target.proposedBy) voices.add(name);
      }
    }
    target.alsoProposedBy = [...voices];
    target.reviewedBy = staffId;
    await this.dataSource.transaction(async (m) => {
      await m.save(target);
      await m.update(
        CallToAction,
        { id: In(others.map((o) => o.id)) },
        { status: 'merged', mergedInto: target.id, reviewedBy: staffId },
      );
    });
    return this.one(into);
  }

  private async one(id: string): Promise<CallToAction> {
    const call = await this.calls.findOneBy({ id });
    if (!call) throw new NotFoundException('Call to action not found');
    return call;
  }

  /** The editable fields that were sent, trimmed; an empty optional one is cleared. */
  private fields(dto: SaveCallToActionDto): Partial<CallToAction> {
    const out: Partial<CallToAction> = {};
    const optional = [
      'proposedBy',
      'proposedByOrganisation',
      'deadline',
      'amount',
      'theme',
      'quote',
    ] as const;
    if (dto.type) out.type = dto.type;
    if (dto.action !== undefined) out.action = dto.action.trim();
    if (dto.shortText !== undefined) out.shortText = dto.shortText.trim();
    if (dto.directedAt !== undefined) out.directedAt = dto.directedAt.trim();
    if (dto.needsDetail !== undefined) out.needsDetail = dto.needsDetail;
    for (const key of optional) {
      const v = dto[key];
      if (v !== undefined) out[key] = v?.trim() || null;
    }
    return out;
  }
}
