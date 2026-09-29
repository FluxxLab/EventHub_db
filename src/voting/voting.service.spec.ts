import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { CatalogService } from '../catalog/catalog.service';
import { RealtimeService } from '../common/realtime/realtime.service';
import { FakeRedis } from '../common/tally/fake-redis.testing';
import {
  LiveTallyService,
  TALLY_EMIT_WINDOW_MS,
} from '../common/tally/live-tally.service';
import { PitchEntry } from './entities/pitch-entry.entity';
import { PitchTopic, TopicVoting } from './entities/pitch-topic.entity';
import { PitchVote } from './entities/pitch-vote.entity';
import { VotingService } from './voting.service';

/** Tracks are the catalog's to check; "nope" stands in for one not in the library. */
const catalog = {
  assertTrack: jest.fn((track: string) =>
    track === 'nope'
      ? Promise.reject(new BadRequestException(`Unknown track: ${track}`))
      : Promise.resolve(),
  ),
};

/**
 * Two rules that fail silently if they regress: a topic nobody has opened must
 * not leave the API at all, and a pitch holding votes must not move ballot.
 * Neither throws when it breaks - one returns extra data, the other corrupts a
 * tally - so nothing but a test reports them.
 */
describe('VotingService withholding rules', () => {
  const topic = (id: string, voting: TopicVoting): PitchTopic => ({
    id,
    name: `topic-${id}`,
    position: 0,
    voting,
    result: null,
    closedAt: null,
    editionId: null,
    createdAt: new Date(),
  });

  const entry = (id: string, topicId: string): PitchEntry =>
    ({ id, topicId, innovatorName: `pitch-${id}` }) as PitchEntry;

  let service: VotingService;
  let entries: { find: jest.Mock; findOneBy: jest.Mock; save: jest.Mock };
  let topics: { find: jest.Mock; findOneBy: jest.Mock; save: jest.Mock };
  let votes: {
    countBy: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let realtime: { emitToRoom: jest.Mock };
  let tx: {
    findOne: jest.Mock;
    findOneBy: jest.Mock;
    countBy: jest.Mock;
    save: jest.Mock;
  };

  beforeEach(async () => {
    entries = { find: jest.fn(), findOneBy: jest.fn(), save: jest.fn() };
    topics = { find: jest.fn(), findOneBy: jest.fn(), save: jest.fn() };
    votes = {
      countBy: jest.fn().mockResolvedValue(0),
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(),
    };
    realtime = { emitToRoom: jest.fn() };
    tx = {
      findOne: jest.fn(),
      findOneBy: jest.fn(),
      countBy: jest.fn().mockResolvedValue(0),
      save: jest.fn((row: unknown) => Promise.resolve(row)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        VotingService,
        { provide: CatalogService, useValue: catalog },
        { provide: getRepositoryToken(PitchEntry), useValue: entries },
        { provide: getRepositoryToken(PitchTopic), useValue: topics },
        { provide: getRepositoryToken(PitchVote), useValue: votes },
        { provide: RealtimeService, useValue: realtime },
        {
          provide: LiveTallyService,
          useValue: new LiveTallyService(new FakeRedis() as unknown as Redis),
        },
        {
          provide: DataSource,
          useValue: {
            manager: {},
            transaction: (cb: (m: typeof tx) => unknown) => cb(tx),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(VotingService);
    // allCounts() is private and hits the query builder; the standings are not
    // what these tests are about.
    jest
      .spyOn(
        service as unknown as { allCounts: () => Promise<Map<string, number>> },
        'allCounts',
      )
      .mockResolvedValue(new Map());
  });

  describe('listTopics', () => {
    beforeEach(() => {
      topics.find.mockResolvedValue([
        topic('open-1', TopicVoting.OPEN),
        topic('pending-1', TopicVoting.PENDING),
        topic('closed-1', TopicVoting.CLOSED),
      ]);
      entries.find.mockResolvedValue([
        entry('e-open', 'open-1'),
        entry('e-pending', 'pending-1'),
      ]);
    });

    it('withholds a pending topic entirely from a delegate', async () => {
      const result = await service.listTopics();

      expect(result.map((t) => t.id)).toEqual(['open-1', 'closed-1']);
      // not the name, not the pitches, not the count
      expect(JSON.stringify(result)).not.toContain('pending-1');
      expect(JSON.stringify(result)).not.toContain('e-pending');
    });

    it('gives admin every topic, since admin curates them', async () => {
      const result = await service.listTopics(true);
      expect(result.map((t) => t.id)).toEqual([
        'open-1',
        'pending-1',
        'closed-1',
      ]);
    });
  });

  describe('listEntries', () => {
    // the topics this event's lists cover; a pitch shows only under one of them
    beforeEach(() => {
      topics.find.mockResolvedValue([
        topic('open-1', TopicVoting.OPEN),
        topic('pending-1', TopicVoting.PENDING),
      ]);
    });

    it('drops pitches whose ballot has not opened', async () => {
      entries.find.mockResolvedValue([
        entry('e-open', 'open-1'),
        entry('e-pending', 'pending-1'),
      ]);

      const result = await service.listEntries();

      expect(result.map((e) => e.id)).toEqual(['e-open']);
    });

    it('keeps them for admin', async () => {
      entries.find.mockResolvedValue([
        entry('e-open', 'open-1'),
        entry('e-pending', 'pending-1'),
      ]);

      const result = await service.listEntries(true);

      expect(result.map((e) => e.id)).toEqual(['e-open', 'e-pending']);
    });

    it("leaves out another event's pitches", async () => {
      entries.find.mockResolvedValue([
        entry('e-open', 'open-1'),
        entry('e-elsewhere', 'other-event-topic'),
      ]);

      const result = await service.listEntries(true, 'edition-1');

      expect(result.map((e) => e.id)).toEqual(['e-open']);
      expect(topics.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { editionId: 'edition-1' } }),
      );
    });
  });

  describe('updateEntry', () => {
    it('refuses to file a pitch under a track the library does not have', async () => {
      await expect(
        service.updateEntry('e1', { track: 'nope' }),
      ).rejects.toThrow('Unknown track: nope');
      await expect(
        service.createEntry({
          innovatorName: 'Ada',
          country: 'Ghana',
          track: 'nope',
          description: 'x',
          topicId: 't1',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses to move a pitch that already holds votes', async () => {
      tx.findOne.mockResolvedValue(entry('e1', 'topic-a'));
      tx.findOneBy.mockResolvedValue(topic('topic-b', TopicVoting.PENDING));
      tx.countBy.mockResolvedValue(3);

      await expect(
        service.updateEntry('e1', { topicId: 'topic-b' }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(tx.save).not.toHaveBeenCalled();
    });

    it('takes a write lock when moving, so a vote cannot land mid-check', async () => {
      tx.findOne.mockResolvedValue(entry('e1', 'topic-a'));
      tx.findOneBy.mockResolvedValue(topic('topic-b', TopicVoting.PENDING));

      await service.updateEntry('e1', { topicId: 'topic-b' });

      expect(tx.findOne).toHaveBeenCalledWith(
        PitchEntry,
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );
    });

    it('allows an unvoted pitch to be assigned to a topic', async () => {
      tx.findOne.mockResolvedValue(entry('e1', 'topic-a'));
      tx.findOneBy.mockResolvedValue(topic('topic-b', TopicVoting.PENDING));

      const saved = await service.updateEntry('e1', { topicId: 'topic-b' });

      expect(saved.topicId).toBe('topic-b');
    });

    it('does not broadcast a pitch whose ballot is still pending', async () => {
      tx.findOne.mockResolvedValue(entry('e1', 'topic-a'));
      tx.findOneBy.mockResolvedValue(topic('topic-b', TopicVoting.PENDING));
      topics.findOneBy.mockResolvedValue(topic('topic-b', TopicVoting.PENDING));

      await service.updateEntry('e1', { topicId: 'topic-b' });

      expect(realtime.emitToRoom).not.toHaveBeenCalled();
    });

    it('broadcasts an edit once the ballot is open', async () => {
      tx.findOneBy.mockResolvedValue(entry('e1', 'topic-a'));
      topics.findOneBy.mockResolvedValue(topic('topic-a', TopicVoting.OPEN));

      await service.updateEntry('e1', { innovatorName: 'Corrected Name' });

      expect(realtime.emitToRoom).toHaveBeenCalledWith(
        'voting',
        'voting:entry-updated',
        expect.objectContaining({ innovatorName: 'Corrected Name' }),
      );
    });

    it('skips the lock for an edit that is not a move', async () => {
      tx.findOneBy.mockResolvedValue(entry('e1', 'topic-a'));
      topics.findOneBy.mockResolvedValue(topic('topic-a', TopicVoting.OPEN));

      await service.updateEntry('e1', { innovatorName: 'Corrected Name' });

      expect(tx.findOne).not.toHaveBeenCalled();
    });
  });
});

/**
 * The live standing moves in Redis, not by a GROUP BY per ballot, and the
 * room hears it at most once a second.
 */
describe('VotingService.castVote live tally', () => {
  const openTopic = {
    id: 't1',
    name: 'Topic',
    position: 0,
    voting: TopicVoting.OPEN,
    result: null,
    closedAt: null,
    createdAt: new Date(),
  } as PitchTopic;

  let service: VotingService;
  let realtime: { emitToRoom: jest.Mock };
  let topics: { findOneBy: jest.Mock };
  let seedQuery: { getRawMany: jest.Mock };
  let previous: Map<string, string>;
  let tx: Record<string, jest.Mock>;

  beforeEach(async () => {
    jest.useFakeTimers();
    previous = new Map();
    realtime = { emitToRoom: jest.fn() };
    topics = { findOneBy: jest.fn().mockResolvedValue(openTopic) };
    seedQuery = {
      getRawMany: jest.fn().mockResolvedValue([{ entryId: 'e1', votes: 2 }]),
    };
    const chain = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: seedQuery.getRawMany,
    };
    const insertChain = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest
        .fn()
        .mockImplementation((v: { delegateId: string; entryId: string }) => {
          previous.set(v.delegateId, v.entryId);
          return insertChain;
        }),
      orUpdate: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    tx = {
      findOneBy: jest.fn((_e: unknown, where: { delegateId: string }) =>
        Promise.resolve(
          previous.has(where.delegateId)
            ? { entryId: previous.get(where.delegateId) }
            : null,
        ),
      ),
      createQueryBuilder: jest.fn().mockReturnValue(insertChain),
      insert: jest.fn().mockResolvedValue(undefined),
    };
    const entries = {
      findOne: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve({ id: where.id, topicId: 't1', topic: openTopic }),
      ),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        VotingService,
        { provide: CatalogService, useValue: catalog },
        { provide: getRepositoryToken(PitchEntry), useValue: entries },
        { provide: getRepositoryToken(PitchTopic), useValue: topics },
        { provide: getRepositoryToken(PitchVote), useValue: {} },
        { provide: RealtimeService, useValue: realtime },
        {
          provide: LiveTallyService,
          useValue: new LiveTallyService(new FakeRedis() as unknown as Redis),
        },
        {
          provide: DataSource,
          useValue: {
            manager: { createQueryBuilder: () => chain },
            transaction: (cb: (m: typeof tx) => unknown) => cb(tx),
          },
        },
      ],
    }).compile();
    service = moduleRef.get(VotingService);
  });

  afterEach(() => jest.useRealTimers());

  it('counts in Redis after one seed, and answers with the live standing', async () => {
    await service.castVote('d1', 'e1');
    await service.castVote('d2', 'e2');
    const tally = await service.castVote('d3', 'e2');

    expect(seedQuery.getRawMany).toHaveBeenCalledTimes(1);
    expect(tally.topicId).toBe('t1');
    expect(tally.voters).toBe(5);
    expect(tally.counts).toEqual(
      expect.arrayContaining([
        { entryId: 'e1', votes: 3 },
        { entryId: 'e2', votes: 2 },
      ]),
    );
  });

  it('moves a changed ballot from the old pitch to the new one', async () => {
    await service.castVote('d1', 'e2');
    const tally = await service.castVote('d1', 'e3');

    expect(tally.voters).toBe(3);
    expect(tally.counts).toEqual(
      expect.arrayContaining([
        { entryId: 'e1', votes: 2 },
        { entryId: 'e3', votes: 1 },
      ]),
    );
    // e2 went to zero and drops out, as it would from the GROUP BY
    expect(tally.counts.find((c) => c.entryId === 'e2')).toBeUndefined();
  });

  // The app re-sends a vote from its offline queue, or after a timeout whose
  // request did land: the same ballot again must change nothing.
  it('treats a replayed ballot as a no-op: no second event, no count moved', async () => {
    const first = await service.castVote('d1', 'e2');
    const replay = await service.castVote('d1', 'e2');

    expect(replay).toEqual(first);
    expect(tx.insert).toHaveBeenCalledTimes(1); // one pitch_vote_events row
    expect(replay.voters).toBe(3);
    expect(replay.counts).toEqual(
      expect.arrayContaining([
        { entryId: 'e1', votes: 2 },
        { entryId: 'e2', votes: 1 },
      ]),
    );
  });

  it('refuses with 409 once the ballot has closed, so a queued vote is dropped, not retried', async () => {
    const closed = { ...openTopic, voting: TopicVoting.CLOSED };
    const entries = (service as unknown as { entries: { findOne: jest.Mock } })
      .entries;
    entries.findOne.mockResolvedValueOnce({
      id: 'e1',
      topicId: 't1',
      topic: closed,
    });
    await expect(service.castVote('d1', 'e1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('broadcasts voting:tally once per window for a burst of ballots', async () => {
    for (let i = 0; i < 40; i++) await service.castVote(`d${i}`, 'e1');
    expect(realtime.emitToRoom).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(TALLY_EMIT_WINDOW_MS + 100);

    expect(realtime.emitToRoom).toHaveBeenCalledTimes(1);
    expect(realtime.emitToRoom).toHaveBeenCalledWith('voting', 'voting:tally', {
      topicId: 't1',
      counts: [{ entryId: 'e1', votes: 42 }],
      voters: 42,
    });
  });

  it('does not broadcast a live standing after the ballot has closed', async () => {
    await service.castVote('d1', 'e1');
    topics.findOneBy.mockResolvedValue({
      ...openTopic,
      voting: TopicVoting.CLOSED,
    });
    await jest.advanceTimersByTimeAsync(TALLY_EMIT_WINDOW_MS + 100);
    expect(realtime.emitToRoom).not.toHaveBeenCalled();
  });
});
