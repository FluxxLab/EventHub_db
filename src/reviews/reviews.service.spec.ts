import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';
import type { StorageService } from '../common/storage/storage.service';
import type { Delegate } from '../delegate/entities/delegate.entity';
import type { EditionsService } from '../editions/editions.service';
import type { Edition } from '../editions/entities/edition.entity';
import type { EventReview } from './entities/event-review.entity';
import {
  REVIEWS_ATTENDEES_ONLY,
  REVIEWS_NOT_OPEN,
  ReviewsService,
} from './reviews.service';

/**
 * Reviews are only worth reading if the people writing them were there, and
 * only honest if a moderated review stops counting. So: who may review, one
 * review per person, and hidden reviews out of the numbers.
 */
const STARTED = new Date(Date.now() - 86_400_000);
const LATER = new Date(Date.now() + 86_400_000);

const review = (over: Partial<EventReview> = {}): EventReview => ({
  id: 'r1',
  editionId: 'e1',
  delegateId: 'ada',
  rating: 5,
  comment: 'Brilliant',
  hidden: false,
  createdAt: new Date('2027-09-08T10:00:00Z'),
  updatedAt: new Date('2027-09-08T10:00:00Z'),
  ...over,
});

function build(opts: {
  startsAt?: Date;
  attended?: boolean;
  own?: EventReview | null;
  page?: EventReview[];
  count?: number;
  average?: string | null;
}) {
  const edition = { id: 'e1', startsAt: opts.startsAt ?? STARTED } as Edition;
  const averageQb = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue({ average: opts.average ?? null }),
  };
  const reviews = {
    findAndCount: jest
      .fn()
      .mockResolvedValue([opts.page ?? [], opts.count ?? 0]),
    createQueryBuilder: jest.fn(() => averageQb),
    findOne: jest.fn().mockResolvedValue(opts.own ?? null),
    create: jest.fn((v: Partial<EventReview>) => v),
    save: jest.fn((v: Partial<EventReview>) =>
      Promise.resolve({
        ...v,
        id: v.id ?? 'new',
        createdAt: v.createdAt ?? new Date(),
      }),
    ),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const delegates = {
    find: jest.fn().mockResolvedValue([
      { id: 'ada', name: 'Ada Okafor', avatarUrl: 'avatars/ada' },
      { id: 'tunde', name: 'Tunde Bakare', avatarUrl: null },
    ]),
  };
  const dataSource = {
    query: jest.fn().mockResolvedValue([{ attended: opts.attended ?? true }]),
  };
  const editions = { findVisible: jest.fn().mockResolvedValue(edition) };
  const storage = {
    resolveAvatar: jest.fn((k: string | null) =>
      Promise.resolve(k ? `https://signed/${k}` : null),
    ),
  };
  const service = new ReviewsService(
    reviews as unknown as Repository<EventReview>,
    delegates as unknown as Repository<Delegate>,
    dataSource as unknown as DataSource,
    editions as unknown as EditionsService,
    storage as unknown as StorageService,
  );
  return { service, reviews, averageQb, dataSource, editions, edition };
}

describe('ReviewsService.eligibility', () => {
  it('is closed before the event starts, even for a ticket holder', async () => {
    const { service, edition, dataSource } = build({
      startsAt: LATER,
      attended: true,
    });
    expect(await service.eligibility(edition, 'ada')).toEqual({
      canReview: false,
      reason: REVIEWS_NOT_OPEN,
    });
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('is open once started to someone with a ticket or an attendance', async () => {
    const { service, edition, dataSource } = build({ attended: true });
    expect(await service.eligibility(edition, 'ada')).toEqual({
      canReview: true,
      reason: null,
    });
    const [sql, params] = dataSource.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FROM tickets t');
    expect(sql).toContain('FROM session_attendance a');
    // a bookmark is an intention, not attendance
    expect(sql).not.toContain('session_bookmarks');
    expect(params).toEqual(['e1', 'ada']);
  });

  it('is closed to someone who was not there', async () => {
    const { service, edition } = build({ attended: false });
    expect(await service.eligibility(edition, 'ada')).toEqual({
      canReview: false,
      reason: REVIEWS_ATTENDEES_ONLY,
    });
  });
});

describe('ReviewsService.submit', () => {
  it('refuses with the reason when the caller may not review', async () => {
    const { service, reviews } = build({ attended: false });
    await expect(
      service.submit('e1', 'ada', { rating: 4 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.submit('e1', 'ada', { rating: 4 })).rejects.toThrow(
      REVIEWS_ATTENDEES_ONLY,
    );
    expect(reviews.save).not.toHaveBeenCalled();
  });

  it('creates a first review, trimming the comment', async () => {
    const { service, reviews } = build({});
    const item = await service.submit('e1', 'ada', {
      rating: 4,
      comment: '  Well run  ',
    });
    expect(reviews.create).toHaveBeenCalledWith({
      editionId: 'e1',
      delegateId: 'ada',
      rating: 4,
      comment: 'Well run',
    });
    expect(item).toMatchObject({
      rating: 4,
      comment: 'Well run',
      author: {
        id: 'ada',
        name: 'Ada Okafor',
        avatarUrl: 'https://signed/avatars/ada',
      },
      mine: true,
    });
  });

  it('replaces an earlier review instead of adding a second, keeping it hidden if it was', async () => {
    const own = review({ hidden: true });
    const { service, reviews } = build({ own });
    await service.submit('e1', 'ada', { rating: 2, comment: '   ' });
    expect(reviews.create).not.toHaveBeenCalled();
    expect(reviews.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'r1',
        rating: 2,
        comment: null,
        hidden: true,
      }),
    );
  });
});

describe('ReviewsService.list', () => {
  it('counts and averages visible reviews only, to one decimal', async () => {
    const { service, reviews, averageQb } = build({
      page: [review(), review({ id: 'r2', delegateId: 'tunde', rating: 4 })],
      count: 3,
      average: '4.3333333',
    });
    const result = await service.list('e1', 'someone', {});
    expect(reviews.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { editionId: 'e1', hidden: false },
        order: { createdAt: 'DESC', id: 'ASC' },
        take: 20,
        skip: 0,
      }),
    );
    expect(averageQb.andWhere).toHaveBeenCalledWith('r.hidden = false');
    expect(result.count).toBe(3);
    expect(result.average).toBe(4.3);
    expect(result.items.map((i) => [i.id, i.mine])).toEqual([
      ['r1', false],
      ['r2', false],
    ]);
    expect(result.mine).toBeNull();
  });

  it('gives the author their own review back even when it is hidden', async () => {
    const own = review({ id: 'mine', hidden: true, rating: 1 });
    const { service } = build({ own, page: [], count: 0, average: null });
    const result = await service.list('e1', 'ada', {});
    expect(result.items).toEqual([]);
    expect(result.average).toBeNull();
    expect(result.mine).toMatchObject({ id: 'mine', rating: 1, mine: true });
    expect(result.canReview).toBe(true);
    expect(result.reason).toBeNull();
  });

  it('says why the caller cannot review', async () => {
    const { service } = build({ startsAt: LATER });
    const result = await service.list('e1', 'ada', {});
    expect(result.canReview).toBe(false);
    expect(result.reason).toBe(REVIEWS_NOT_OPEN);
  });
});

describe('ReviewsService moderation and deletion', () => {
  it('hides a review', async () => {
    const { service, reviews } = build({ own: review() });
    await service.setHidden('r1', true);
    expect(reviews.update).toHaveBeenCalledWith({ id: 'r1' }, { hidden: true });
  });

  it('404s hiding a review that does not exist', async () => {
    const { service } = build({ own: null });
    await expect(service.setHidden('nope', true)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('deletes only the review of the caller', async () => {
    const { service, reviews } = build({});
    await service.remove('e1', 'ada');
    expect(reviews.delete).toHaveBeenCalledWith({
      editionId: 'e1',
      delegateId: 'ada',
    });
  });
});
