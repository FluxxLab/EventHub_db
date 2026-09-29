import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import type { AuthUser } from '../auth/strategies/jwt.stategies';
import { RealtimeService, Rooms } from '../common/realtime/realtime.service';
import { Counts, LiveTallyService } from '../common/tally/live-tally.service';
import { AccessTier } from '../delegate/entities/delegate.entity';
import { CreatePollDto, UpdatePollDto } from './dto/polls.dto';
import { PollVote } from './entities/poll-vote.entity';
import { Poll, PollStatus } from './entities/poll.entity';

/** Who is asking; decides whether a hidden tally is shown and fills `myVote`. */
export type PollViewer = Pick<AuthUser, 'id' | 'role'>;

export interface PollView {
  id: string;
  editionId: string | null;
  sessionId: string | null;
  question: string;
  options: string[];
  status: PollStatus;
  showResults: boolean;
  /** Null for delegates while the poll is open with results hidden. */
  counts: number[] | null;
  total: number;
  myVote: number | null;
  openedAt: string | null;
  closedAt: string | null;
}

export interface PollResultsEvent {
  id: string;
  counts: number[];
  total: number;
}

interface Tally {
  counts: number[];
  total: number;
}

/** A grouped count row as Postgres returns it: COUNT(*) is a bigint, so a string. */
interface TallyRow {
  pollId: string;
  optionIndex: number | string;
  count: string;
}

const countsKey = (pollId: string) => LiveTallyService.key('poll', pollId);

/** Per-option counts as hash fields keyed by option index. */
const byIndex = (counts: number[]): Counts =>
  Object.fromEntries(counts.map((n, i) => [String(i), n]));

@Injectable()
export class PollsService {
  constructor(
    @InjectRepository(Poll)
    private readonly polls: Repository<Poll>,
    @InjectRepository(PollVote)
    private readonly votes: Repository<PollVote>,
    private readonly realtime: RealtimeService,
    private readonly live: LiveTallyService,
  ) {}

  /* ---------------------------------------------------------------- delegate */

  /**
   * The poll the room is answering right now. When two are somehow open
   * (a race between two operators), the most recently opened wins, which is
   * the one the MC is talking about.
   */
  async current(
    viewer: PollViewer,
    editionId?: string,
  ): Promise<PollView | null> {
    const [poll] = await this.polls.find({
      where: { status: PollStatus.OPEN, ...(editionId && { editionId }) },
      order: { openedAt: 'DESC' },
      take: 1,
    });
    if (!poll) return null;
    const [view] = await this.views([poll], viewer);
    return view;
  }

  /**
   * A second vote replaces the first: the unique (poll, delegate) pair turns
   * the insert into an update, so changing your mind is one query and two
   * quick taps cannot count twice.
   *
   * The live standing is kept in Redis (one HINCRBY per option moved) rather
   * than counted from Postgres per vote, and the room hears it at most once
   * a second. Closing counts from Postgres, which stays the source of truth.
   */
  async vote(
    viewer: PollViewer,
    pollId: string,
    optionIndex: number,
  ): Promise<PollView> {
    const poll = await this.findById(pollId);
    if (poll.status !== PollStatus.OPEN) {
      throw new BadRequestException('This poll is not open');
    }
    if (optionIndex < 0 || optionIndex >= poll.options.length) {
      throw new BadRequestException('That option does not exist');
    }
    const key = countsKey(poll.id);
    // Seeded before the write so a cold seed cannot already hold this vote.
    await this.live.ensure(key, () => this.countsFromDb(poll));

    const previous = await this.votes.findOne({
      where: { pollId, delegateId: viewer.id },
      select: { optionIndex: true },
    });
    await this.votes.upsert(
      { pollId, delegateId: viewer.id, optionIndex },
      { conflictPaths: ['pollId', 'delegateId'] },
    );

    if (previous?.optionIndex !== optionIndex) {
      await this.live.apply(key, {
        [optionIndex]: 1,
        ...(previous && { [previous.optionIndex]: -1 }),
      });
      // A hidden tally stays hidden until close; the phones only need the total then.
      if (poll.showResults) {
        await this.live.coalesce(`poll:${poll.id}`, () =>
          this.emitResults(poll.id),
        );
      }
    }

    const tally = this.toTally(poll, await this.live.read(key));
    return this.toView(poll, tally, optionIndex, viewer);
  }

  /** Closed polls, newest first: the "what did the room think" list. */
  async history(viewer: PollViewer, editionId?: string): Promise<PollView[]> {
    const rows = await this.polls.find({
      where: { status: PollStatus.CLOSED, ...(editionId && { editionId }) },
      order: { closedAt: 'DESC' },
    });
    return this.views(rows, viewer);
  }

  /* ------------------------------------------------------------------- admin */

  async list(viewer: PollViewer, editionId?: string): Promise<PollView[]> {
    const rows = await this.polls.find({
      where: editionId ? { editionId } : {},
      order: { createdAt: 'DESC' },
    });
    return this.views(rows, viewer);
  }

  async create(viewer: PollViewer, dto: CreatePollDto): Promise<PollView> {
    const poll = await this.polls.save(
      this.polls.create({
        editionId: dto.editionId ?? null,
        sessionId: dto.sessionId ?? null,
        question: dto.question.trim(),
        options: dto.options.map((o) => o.trim()),
        showResults: dto.showResults ?? true,
        status: PollStatus.DRAFT,
      }),
    );
    const [view] = await this.views([poll], viewer);
    return view;
  }

  /**
   * Drafts only. Once a poll has opened its options are what people voted
   * on; renaming option 2 after the fact would rewrite their answers.
   */
  async update(
    viewer: PollViewer,
    id: string,
    dto: UpdatePollDto,
  ): Promise<PollView> {
    const poll = await this.findById(id);
    if (poll.status !== PollStatus.DRAFT) {
      throw new BadRequestException('Only a draft poll can be edited');
    }
    Object.assign(poll, {
      ...(dto.editionId !== undefined && { editionId: dto.editionId }),
      ...(dto.sessionId !== undefined && { sessionId: dto.sessionId }),
      ...(dto.question !== undefined && { question: dto.question.trim() }),
      ...(dto.options !== undefined && {
        options: dto.options.map((o) => o.trim()),
      }),
      ...(dto.showResults !== undefined && { showResults: dto.showResults }),
    });
    const [view] = await this.views([await this.polls.save(poll)], viewer);
    return view;
  }

  /**
   * One open poll per edition: the stage screen and the phones show one
   * question, so opening this one closes whatever was open, with its final
   * tally broadcast as if the operator had closed it by hand.
   */
  async open(viewer: PollViewer, id: string): Promise<PollView> {
    const poll = await this.findById(id);
    if (poll.status === PollStatus.OPEN) {
      throw new BadRequestException('This poll is already open');
    }
    const others = await this.polls.find({
      where: {
        status: PollStatus.OPEN,
        editionId: poll.editionId ?? IsNull(),
        id: Not(id),
      },
    });
    for (const other of others) {
      await this.finish(other);
    }

    poll.status = PollStatus.OPEN;
    poll.openedAt = new Date();
    poll.closedAt = null;
    const saved = await this.polls.save(poll);
    const tally = (await this.tallies([saved])).get(saved.id)!;
    this.realtime.emitToRoom(
      Rooms.polls,
      'poll:opened',
      this.toView(saved, tally, null, null),
    );
    return this.toView(saved, tally, null, viewer);
  }

  async close(viewer: PollViewer, id: string): Promise<PollView> {
    const poll = await this.findById(id);
    if (poll.status !== PollStatus.OPEN) {
      throw new BadRequestException('This poll is not open');
    }
    const [view] = await this.views([await this.finish(poll)], viewer);
    return view;
  }

  /**
   * Removes the poll and every vote on it. An open one is announced as
   * closed first so a phone showing it clears the card instead of waiting
   * on a poll that no longer exists.
   */
  async remove(id: string): Promise<void> {
    const poll = await this.findById(id);
    if (poll.status === PollStatus.OPEN) await this.finish(poll);
    await this.votes.delete({ pollId: id });
    await this.polls.delete({ id });
    await this.live.drop(countsKey(id));
  }

  /* --------------------------------------------------------------- internals */

  private async findById(id: string): Promise<Poll> {
    const poll = await this.polls.findOne({ where: { id } });
    if (!poll) throw new NotFoundException('Poll not found');
    return poll;
  }

  /** Marks the poll closed and broadcasts its final tally to everyone. */
  private async finish(poll: Poll): Promise<Poll> {
    poll.status = PollStatus.CLOSED;
    poll.closedAt = new Date();
    const saved = await this.polls.save(poll);
    const tally = (await this.tallies([saved])).get(saved.id)!;
    // the result is final: overwrite whatever the live counts drifted to
    await this.live.reset(countsKey(saved.id), byIndex(tally.counts));
    this.realtime.emitToRoom(
      Rooms.polls,
      'poll:closed',
      this.toView(saved, tally, null, null),
    );
    return saved;
  }

  /**
   * One grouped query for however many polls are being rendered, rather
   * than a count per option per poll: the history list is every closed
   * poll of the summit.
   */
  private async tallies(polls: Poll[]): Promise<Map<string, Tally>> {
    const tallies = new Map<string, Tally>(
      polls.map((p) => [p.id, { counts: p.options.map(() => 0), total: 0 }]),
    );
    if (polls.length === 0) return tallies;

    const rows = await this.votes
      .createQueryBuilder('v')
      .select('v.pollId', 'pollId')
      .addSelect('v.optionIndex', 'optionIndex')
      .addSelect('COUNT(*)', 'count')
      .where('v.pollId IN (:...ids)', { ids: polls.map((p) => p.id) })
      .groupBy('v.pollId')
      .addGroupBy('v.optionIndex')
      .getRawMany<TallyRow>();

    for (const row of rows) {
      const tally = tallies.get(row.pollId);
      const index = Number(row.optionIndex);
      // an index past the options can only come from a poll edited by hand in the DB
      if (!tally || index < 0 || index >= tally.counts.length) continue;
      const count = Number(row.count);
      tally.counts[index] = count;
      tally.total += count;
    }
    return tallies;
  }

  /** One poll's counts from Postgres keyed by option index; seeds a cold Redis key. */
  private async countsFromDb(poll: Poll): Promise<Counts> {
    return byIndex((await this.tallies([poll])).get(poll.id)!.counts);
  }

  /** Redis counts (option index -> votes) in the shape the views carry. */
  private toTally(poll: Poll, raw: Counts): Tally {
    const counts = poll.options.map((_, i) => Math.max(0, raw[i] ?? 0));
    return { counts, total: counts.reduce((a, b) => a + b, 0) };
  }

  /**
   * The coalesced `poll:results` broadcast, read from Redis when it fires.
   * Skipped once the poll has closed or hidden its results: `poll:closed`
   * carries the final tally and a late live one must not land on top of it.
   */
  private async emitResults(pollId: string): Promise<void> {
    const poll = await this.polls.findOne({ where: { id: pollId } });
    if (!poll || poll.status !== PollStatus.OPEN || !poll.showResults) return;
    const results: PollResultsEvent = {
      id: poll.id,
      ...this.toTally(poll, await this.live.read(countsKey(poll.id))),
    };
    this.realtime.emitToRoom(Rooms.polls, 'poll:results', results);
  }

  private async views(polls: Poll[], viewer: PollViewer): Promise<PollView[]> {
    if (polls.length === 0) return [];
    const tallies = await this.tallies(polls);
    const mine = await this.votes.find({
      where: { delegateId: viewer.id, pollId: In(polls.map((p) => p.id)) },
    });
    const myVotes = new Map(mine.map((v) => [v.pollId, v.optionIndex]));
    return polls.map((p) =>
      this.toView(p, tallies.get(p.id)!, myVotes.get(p.id) ?? null, viewer),
    );
  }

  /**
   * The tally is withheld from delegates while an open poll hides its
   * results. Operators always see it, and everyone sees it once the poll
   * closes. `viewer` is null for a broadcast, which every phone receives and
   * so must carry the delegate view.
   */
  private toView(
    poll: Poll,
    tally: Tally,
    myVote: number | null,
    viewer: PollViewer | null,
  ): PollView {
    const operator =
      viewer?.role === AccessTier.ADMIN ||
      viewer?.role === AccessTier.SESSION_ADMIN ||
      viewer?.role === AccessTier.EVENT_ADMIN;
    const revealed =
      poll.status === PollStatus.CLOSED || poll.showResults || operator;
    return {
      id: poll.id,
      editionId: poll.editionId,
      sessionId: poll.sessionId,
      question: poll.question,
      options: poll.options,
      status: poll.status,
      showResults: poll.showResults,
      counts: revealed ? tally.counts : null,
      total: tally.total,
      myVote,
      openedAt: poll.openedAt?.toISOString() ?? null,
      closedAt: poll.closedAt?.toISOString() ?? null,
    };
  }
}
