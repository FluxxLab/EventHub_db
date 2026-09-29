import { NotFoundException } from '@nestjs/common';
import type Redis from 'ioredis';
import type { DataSource, Repository } from 'typeorm';
import type { CatalogService } from '../catalog/catalog.service';
import type { RealtimeService } from '../common/realtime/realtime.service';
import { editionFromJoin } from '../common/realtime/edition-room';
import { FakeRedis } from '../common/tally/fake-redis.testing';
import { LiveTallyService } from '../common/tally/live-tally.service';
import type { PitchEntry } from './entities/pitch-entry.entity';
import { PitchTopic, TopicVoting } from './entities/pitch-topic.entity';
import type { PitchVote } from './entities/pitch-vote.entity';
import { VotingService } from './voting.service';

const GS27 = '7b0c3f4e-9a1d-4e2b-8c55-0d9f1e2a3b4c';

function build(topic: Partial<PitchTopic>) {
  const topics = {
    findOneBy: jest.fn().mockResolvedValue({ id: 't1', ...topic }),
    find: jest.fn().mockResolvedValue([{ id: 't1' }]),
    save: jest.fn((t: PitchTopic) => Promise.resolve(t)),
    create: jest.fn((t: Partial<PitchTopic>) => t),
    delete: jest.fn().mockResolvedValue({}),
  };
  const votes = {
    findBy: jest.fn().mockResolvedValue([
      { topicId: 't1', entryId: 'e1' },
      { topicId: 't-other-event', entryId: 'e9' },
    ]),
    delete: jest.fn().mockResolvedValue({}),
  };
  const realtime = { emitToRoom: jest.fn() };
  const dataSource = {
    query: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
  };
  const service = new VotingService(
    {} as Repository<PitchEntry>,
    votes as unknown as Repository<PitchVote>,
    topics as unknown as Repository<PitchTopic>,
    realtime as unknown as RealtimeService,
    dataSource as unknown as DataSource,
    new LiveTallyService(new FakeRedis() as unknown as Redis),
    {} as CatalogService,
  );
  return { service, topics, votes, realtime, dataSource };
}

describe('VotingService per event', () => {
  it("pushes a ballot's changes to its event's room as well as the summit-wide one", async () => {
    const { service, realtime } = build({
      editionId: GS27,
      voting: TopicVoting.PENDING,
    });
    await service.openVoting('t1');
    expect(realtime.emitToRoom).toHaveBeenCalledWith(
      [`voting:${GS27}`, 'voting'],
      'voting:opened',
      { topicId: 't1', editionId: GS27 },
    );
  });

  it('keeps a topic made before events were linked on the summit-wide room', async () => {
    const { service, realtime } = build({
      editionId: null,
      voting: TopicVoting.OPEN,
    });
    await service.removeTopic('t1');
    expect(realtime.emitToRoom).toHaveBeenCalledWith(
      'voting',
      'voting:topic-deleted',
      { topicId: 't1', editionId: null },
    );
  });

  it('refuses a topic for an event that does not exist', async () => {
    const { service, topics, dataSource } = build({});
    dataSource.query.mockResolvedValueOnce([]);
    await expect(
      service.createTopic({ name: 'Health', editionId: GS27 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(topics.save).not.toHaveBeenCalled();

    await service.createTopic({ name: 'Health', editionId: GS27 });
    expect(topics.create).toHaveBeenCalledWith({
      name: 'Health',
      editionId: GS27,
    });
  });

  it("returns only the named event's ballots in my-votes", async () => {
    const { service, topics } = build({});
    await expect(service.myVotes('d1', GS27)).resolves.toEqual({ t1: 'e1' });
    expect(topics.find).toHaveBeenCalledWith({
      where: { editionId: GS27 },
      select: { id: true },
    });
    await expect(service.myVotes('d1')).resolves.toEqual({
      t1: 'e1',
      't-other-event': 'e9',
    });
  });
});

describe('editionFromJoin', () => {
  it('reads an event id from the join payload, or falls back to the summit-wide room', () => {
    expect(editionFromJoin({ editionId: GS27 })).toBe(GS27);
    expect(editionFromJoin(GS27)).toBe(GS27);
    expect(editionFromJoin(undefined)).toBeNull();
    expect(editionFromJoin({ editionId: 'gs26' })).toBeNull();
    expect(editionFromJoin({ editionId: 42 })).toBeNull();
  });
});
