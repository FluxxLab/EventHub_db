import { EditionAccessService } from '../common/edition-scope/edition-access.service';
import { CatalogService } from '../catalog/catalog.service';
import {
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  Repository,
  FindOptionsWhere,
  IsNull,
} from 'typeorm';
import { RealtimeService, Rooms } from '../common/realtime/realtime.service';
import { eventRooms } from '../common/realtime/edition-room';
import { Counts, LiveTallyService } from '../common/tally/live-tally.service';
import { CreatePitchEntryDto } from './dto/create-pitch-entry.dto';
import { UpdatePitchEntryDto } from './dto/update-pitch-entry.dto';
import { CreatePitchTopicDto } from './dto/create-pitch-topic.dto';
import { UpdatePitchTopicDto } from './dto/update-pitch-topic.dto';
import { PitchEntry } from './entities/pitch-entry.entity';
import {
  PitchTopic,
  TopicTally,
  TopicVoting,
} from './entities/pitch-topic.entity';
import { PitchVote } from './entities/pitch-vote.entity';
import { PitchVoteEvent } from './entities/pitch-vote-event.entities';

const topicKey = (topicId: string) => LiveTallyService.key('topic', topicId);

/** A topic's event room plus the summit-wide one (see eventRooms). */
const roomsFor = (editionId: string | null | undefined) =>
  eventRooms(Rooms.voting, Rooms.votingEdition, editionId);

@Injectable()
export class VotingService {
  constructor(
    @InjectRepository(PitchEntry)
    private readonly entries: Repository<PitchEntry>,
    @InjectRepository(PitchVote)
    private readonly votes: Repository<PitchVote>,
    @InjectRepository(PitchTopic)
    private readonly topics: Repository<PitchTopic>,
    private readonly realtime: RealtimeService,
    private readonly dataSource: DataSource,
    private readonly live: LiveTallyService,
    private readonly catalog: CatalogService,
    /** The current edition, which the app shows. Optional for the hand-built specs. */
    @Optional()
    private readonly access?: EditionAccessService,
  ) {}

  /**
   * Which topics a list shows: one event's when named (the console), else the
   * event the app shows plus any made before topics had an event.
   */
  private async topicScope(
    editionId?: string,
  ): Promise<FindOptionsWhere<PitchTopic>[] | FindOptionsWhere<PitchTopic>> {
    if (editionId) return { editionId };
    const current = (await this.access?.currentEdition()) ?? null;
    return current ? [{ editionId: current }, { editionId: IsNull() }] : {};
  }

  /* ---------------------------------------------------------------- topics */

  /**
   * Every topic with its pitches and live standing.
   *
   * One call rather than entries-plus-a-tally-each because both clients render
   * the pitchathon grouped by topic: a ballot is only meaningful next to the
   * others on the same ballot.
   *
   * A pending topic is withheld from delegates in full - not its name, not its
   * innovators, not its pitch count. The reveal is the moment voting opens, so
   * it has to be enforced here: filtering in the client would still ship the
   * unopened line-up to every phone, one response body away from being read.
   * Admin curates topics before they open, so admin sees them all.
   */
  async listTopics(includePending = false, editionId?: string) {
    const [topics, entries, counts] = await Promise.all([
      this.topics.find({
        where: await this.topicScope(editionId),
        order: { position: 'ASC', createdAt: 'ASC' },
      }),
      this.entries.find({ order: { createdAt: 'ASC' } }),
      this.allCounts(),
    ]);

    const visible = includePending
      ? topics
      : topics.filter((t) => t.voting !== TopicVoting.PENDING);

    return visible.map((topic) => {
      const own = entries
        .filter((e) => e.topicId === topic.id)
        .map((e) => ({ ...e, voteCount: counts.get(e.id) ?? 0 }));

      return {
        ...topic,
        entries: own,
        // Ballots cast in this topic. One per delegate, so this is turnout.
        voters: own.reduce((n, e) => n + e.voteCount, 0),
      };
    });
  }

  /** The event is named by the caller (the DTO requires it) and must exist. */
  async createTopic(dto: CreatePitchTopicDto): Promise<PitchTopic> {
    const found = await this.dataSource.query<unknown[]>(
      `SELECT 1 FROM editions WHERE id = $1`,
      [dto.editionId],
    );
    if (found.length === 0) throw new NotFoundException('Event not found');
    return this.topics.save(this.topics.create(dto));
  }

  async updateTopic(id: string, dto: UpdatePitchTopicDto): Promise<PitchTopic> {
    const topic = await this.topics.findOneBy({ id });
    if (!topic) throw new NotFoundException('Topic not found');

    Object.assign(topic, dto);
    const saved = await this.topics.save(topic);
    // The voting room is every delegate, so a pending topic's name cannot go
    // out on it - withholding it from GET /topics and then broadcasting it
    // here would leak the same thing by the other channel. Admin sees the
    // change in this call's own response; it lands for everyone when the
    // ballot opens.
    if (saved.voting !== TopicVoting.PENDING)
      this.realtime.emitToRoom(
        roomsFor(saved.editionId),
        'voting:topic-updated',
        saved,
      );
    return saved;
  }

  /**
   * Opening is a separate act from creating the topic on purpose: the ballot
   * must not accept a vote until every pitch in it has presented, or whoever
   * pitched last is voting into a race that is already decided.
   */
  async openVoting(id: string): Promise<PitchTopic> {
    const topic = await this.topics.findOneBy({ id });
    if (!topic) throw new NotFoundException('Topic not found');
    if (topic.voting === TopicVoting.CLOSED)
      throw new ConflictException('Voting for this topic is already closed');
    if (topic.voting === TopicVoting.OPEN) return topic; // idempotent

    topic.voting = TopicVoting.OPEN;
    const saved = await this.topics.save(topic);
    this.realtime.emitToRoom(roomsFor(saved.editionId), 'voting:opened', {
      topicId: id,
      editionId: saved.editionId,
    });
    return saved;
  }

  /** Closing is the moment the result becomes a fact. The tally is snapshotted
   *  onto the topic in the same transaction that closes it, so what was
   *  announced stays retrievable no matter what the live query later says. */
  async closeVoting(topicId: string) {
    const closed = await this.dataSource.transaction(async (tx) => {
      const topic = await tx.findOne(PitchTopic, {
        where: { id: topicId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!topic) throw new NotFoundException('Topic not found');
      if (topic.voting === TopicVoting.CLOSED) return topic; // idempotent

      topic.voting = TopicVoting.CLOSED;
      topic.result = await this.tally(topicId, tx);
      topic.closedAt = new Date();

      const saved = await tx.save(topic);
      this.realtime.emitToRoom(roomsFor(saved.editionId), 'voting:closed', {
        ...saved.result,
        editionId: saved.editionId,
      });
      return saved;
    });
    // The snapshot is the result; the live counts are overwritten to match.
    if (closed.result) {
      await this.live.reset(topicKey(topicId), this.toCounts(closed.result));
    }
    return closed;
  }

  /**
   * Removes the topic, its pitches (FK cascade) and every ballot cast in it.
   * The votes go explicitly rather than by cascade because they hang off the
   * topic id, not off a foreign key to it.
   */
  async removeTopic(id: string): Promise<void> {
    const topic = await this.topics.findOneBy({ id });
    if (!topic) throw new NotFoundException('Topic not found');

    await this.votes.delete({ topicId: id });
    await this.topics.delete({ id });
    await this.live.drop(topicKey(id));

    this.realtime.emitToRoom(
      roomsFor(topic.editionId),
      'voting:topic-deleted',
      {
        topicId: id,
        editionId: topic.editionId,
      },
    );
  }

  /* --------------------------------------------------------------- entries */

  /**
   * Flat list of pitches. Carries the same withholding rule as listTopics -
   * a pitch on an unopened ballot is exactly what must not be visible, and
   * this endpoint would otherwise hand it over without the topic wrapper.
   */
  async listEntries(
    includePending = false,
    editionId?: string,
  ): Promise<Array<PitchEntry & { voteCount: number }>> {
    const [entries, counts, topics] = await Promise.all([
      this.entries.find({ order: { createdAt: 'ASC' } }),
      this.allCounts(),
      this.topics.find({
        where: await this.topicScope(editionId),
        select: { id: true, voting: true },
      }),
    ]);

    // this event's pitches only, and none on a ballot that has not opened
    const shown = new Set(
      topics
        .filter((t) => includePending || t.voting !== TopicVoting.PENDING)
        .map((t) => t.id),
    );
    const visible = entries.filter((e) => shown.has(e.topicId));

    return visible.map((e) => ({ ...e, voteCount: counts.get(e.id) ?? 0 }));
  }

  async createEntry(dto: CreatePitchEntryDto): Promise<PitchEntry> {
    await this.catalog.assertTrack(dto.track);
    return this.entries.save(this.entries.create(dto));
  }

  /**
   * Admin edit, including moving a pitch onto another ballot (dto.topicId) -
   * that is how a pitch gets assigned out of the unassigned bucket.
   *
   * Correcting a name or a description cannot disturb the tally. Moving the
   * pitch can: its ballots are recorded against a topic, so carrying a pitch
   * that already holds votes into another topic would take those votes with it
   * and leave two tallies wrong. A pitch is therefore only movable while no
   * one has voted for it - which is to say, before its ballot opens.
   */
  async updateEntry(
    id: string,
    dto: UpdatePitchEntryDto,
  ): Promise<PitchEntry & { voteCount: number }> {
    if (dto.track !== undefined) await this.catalog.assertTrack(dto.track);
    const moving = Boolean(dto.topicId);

    // A move is checked and applied under one lock. Counting the votes and
    // then saving as two statements leaves a window: a ballot cast between
    // them passes a check that was already stale, and the vote lands on a
    // pitch that is no longer in the topic it was cast for. An edit that is
    // not a move touches nothing votes depend on, so it skips the lock.
    const { saved, voteCount } = await this.dataSource.transaction(
      async (tx) => {
        const entry = moving
          ? await tx.findOne(PitchEntry, {
              where: { id },
              lock: { mode: 'pessimistic_write' },
            })
          : await tx.findOneBy(PitchEntry, { id });
        if (!entry) throw new NotFoundException('Pitch entry not found');

        if (dto.topicId && dto.topicId !== entry.topicId) {
          const target = await tx.findOneBy(PitchTopic, { id: dto.topicId });
          if (!target) throw new NotFoundException('Target topic not found');

          const cast = await tx.countBy(PitchVote, { entryId: id });
          if (cast > 0)
            throw new ConflictException(
              'This pitch already holds votes and can no longer be moved to another topic',
            );
        }

        Object.assign(entry, dto);
        const row = await tx.save(entry);
        return {
          saved: row,
          voteCount: await tx.countBy(PitchVote, { entryId: id }),
        };
      },
    );

    // Same rule as the topic broadcast: this payload is the pitch itself -
    // innovator, country, description - so it must not reach the voting room
    // while its ballot is unopened. That is precisely what is being withheld.
    const topic = await this.topics.findOneBy({ id: saved.topicId });
    if (topic && topic.voting !== TopicVoting.PENDING)
      this.realtime.emitToRoom(
        roomsFor(topic.editionId),
        'voting:entry-updated',
        { ...saved, voteCount, editionId: topic.editionId },
      );
    return { ...saved, voteCount };
  }

  /**
   * Withdrawal. The ballots resting on this entry go with it, which returns
   * those delegates to "not yet voted" in the topic - the alternative is a
   * ballot pointing at a pitch that no longer exists and a delegate who can
   * never re-cast it.
   *
   * The topic's whole tally rides on the event because two numbers changed:
   * this entry's count vanished and the topic's turnout dropped with it.
   */
  async removeEntry(id: string): Promise<void> {
    const entry = await this.entries.findOneBy({ id });
    if (!entry) throw new NotFoundException('Pitch entry not found');

    await this.votes.delete({ entryId: id });
    await this.entries.delete({ id });

    const tally = await this.tally(entry.topicId);
    // the withdrawn pitch's ballots are gone; the live counts follow Postgres
    await this.live.reset(topicKey(entry.topicId), this.toCounts(tally));
    const topic = await this.topics.findOneBy({ id: entry.topicId });
    const editionId = topic?.editionId ?? null;
    this.realtime.emitToRoom(roomsFor(editionId), 'voting:entry-deleted', {
      entryId: id,
      topicId: entry.topicId,
      editionId,
      tally,
    });
  }

  /* ----------------------------------------------------------------- votes */

  /**
   * One ballot per delegate per topic, changeable while the topic is open.
   *
   * The ballot row and its audit event are written in Postgres; the live
   * standing moves in Redis (+1 on the new pitch, -1 on the old) instead of
   * a GROUP BY per vote, and the room hears it at most once a second.
   * Closing snapshots the count from Postgres, which stays the source of
   * truth for the result.
   */
  async castVote(delegateId: string, entryId: string): Promise<TopicTally> {
    const entry = await this.entries.findOne({
      where: { id: entryId },
      relations: { topic: true },
    });
    if (!entry) throw new NotFoundException('Pitch entry not found');
    if (entry.topic.voting !== TopicVoting.OPEN)
      throw new ConflictException('Voting is not open for this topic');

    const { topicId } = entry;
    const key = topicKey(topicId);
    // Seeded before the write so a cold seed cannot already hold this ballot.
    await this.live.ensure(key, async () =>
      this.toCounts(await this.tally(topicId)),
    );

    const moved = await this.dataSource.transaction(async (tx) => {
      const previous = await tx.findOneBy(PitchVote, { delegateId, topicId });
      if (previous?.entryId === entryId) return null; // no-op re-tap

      await tx
        .createQueryBuilder()
        .insert()
        .into(PitchVote)
        .values({ delegateId, topicId, entryId })
        .orUpdate(['entryId', 'updatedAt'], ['delegateId', 'topicId'])
        .execute();

      await tx.insert(PitchVoteEvent, {
        delegateId,
        topicId,
        entryId,
        previousEntryId: previous?.entryId ?? null,
      });

      return { previousEntryId: previous?.entryId ?? null };
    });

    if (moved) {
      await this.live.apply(key, {
        [entryId]: 1,
        ...(moved.previousEntryId && { [moved.previousEntryId]: -1 }),
      });
      await this.live.coalesce(`topic:${topicId}`, () =>
        this.emitTally(topicId),
      );
    }

    return this.liveTally(topicId);
  }

  /**
   * topicId -> the entry this delegate currently has their vote on.
   *
   * A map rather than a list of ids because the client has to render which
   * pitch is selected within each ballot, and a flat list cannot express that.
   */
  async myVotes(
    delegateId: string,
    editionId?: string,
  ): Promise<Record<string, string>> {
    const rows = await this.votes.findBy({ delegateId });
    if (!editionId || rows.length === 0)
      return Object.fromEntries(rows.map((r) => [r.topicId, r.entryId]));
    // one event's ballots only: the app renders them next to that event's topics
    const own = new Set(
      (
        await this.topics.find({ where: { editionId }, select: { id: true } })
      ).map((t) => t.id),
    );
    return Object.fromEntries(
      rows.filter((r) => own.has(r.topicId)).map((r) => [r.topicId, r.entryId]),
    );
  }

  /**
   * Most-voted pitches across every topic, for the Overview widget. Not a
   * ranking anyone wins - the winners are per topic, decided on their own
   * ballot - so this is presented as "most votes", never as a leaderboard.
   */
  async topPitches(limit = 5, includePending = false, editionId?: string) {
    const all = await this.listEntries(includePending, editionId);
    return all
      .sort((a, b) => b.voteCount - a.voteCount)
      .slice(0, limit)
      .map(({ voteCount, ...entry }) => ({ entry, voteCount }));
  }

  /* -------------------------------------------------------------- counting */

  /**
   * One topic's full standing, counted from Postgres. Used where the result
   * matters (closing, withdrawing a pitch) and to seed the live Redis counts;
   * never per vote - a vote moves the Redis counts by +1/-1 instead.
   *
   * Takes the transaction manager so closeVoting reads it under its lock.
   */
  private async tally(
    topicId: string,
    tx: EntityManager = this.dataSource.manager,
  ): Promise<TopicTally> {
    const rows = await tx
      .createQueryBuilder(PitchVote, 'v')
      .select('v.entryId', 'entryId')
      .addSelect('COUNT(*)::int', 'votes')
      .where('v.topicId = :topicId', { topicId })
      .groupBy('v.entryId')
      .getRawMany<{ entryId: string; votes: number }>();

    return {
      topicId,
      counts: rows,
      voters: rows.reduce((n, r) => n + r.votes, 0),
    };
  }

  /** A topic's standing from the Redis counts, in the TopicTally shape. */
  private async liveTally(topicId: string): Promise<TopicTally> {
    const raw = await this.live.read(topicKey(topicId));
    // a pitch whose votes all moved away drops out, as it would from the GROUP BY
    const counts = Object.entries(raw)
      .filter(([, votes]) => votes > 0)
      .map(([entryId, votes]) => ({ entryId, votes }));
    return {
      topicId,
      counts,
      voters: counts.reduce((n, r) => n + r.votes, 0),
    };
  }

  private toCounts(tally: TopicTally): Counts {
    return Object.fromEntries(tally.counts.map((c) => [c.entryId, c.votes]));
  }

  /**
   * The coalesced `voting:tally` broadcast, read from Redis when it fires.
   * Skipped once the ballot has closed: `voting:closed` carries the result
   * and a late live standing must not land on top of it.
   */
  private async emitTally(topicId: string): Promise<void> {
    const topic = await this.topics.findOneBy({ id: topicId });
    if (topic?.voting !== TopicVoting.OPEN) return;
    this.realtime.emitToRoom(roomsFor(topic.editionId), 'voting:tally', {
      ...(await this.liveTally(topicId)),
      editionId: topic.editionId,
    });
  }

  /**
   * Every entry's count in a single grouped query. The list endpoints would
   * otherwise fire one count per entry, which is the shape the Redis counter
   * existed to avoid.
   */
  private async allCounts(): Promise<Map<string, number>> {
    const rows = await this.votes
      .createQueryBuilder('v')
      .select('v.entryId', 'entryId')
      .addSelect('COUNT(*)::int', 'votes')
      .groupBy('v.entryId')
      .getRawMany<{ entryId: string; votes: number }>();

    return new Map(rows.map((r) => [r.entryId, r.votes]));
  }
}
