import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { StorageService } from '../common/storage/storage.service';
import { Delegate } from '../delegate/entities/delegate.entity';
import { EditionsService } from '../editions/editions.service';
import { Edition } from '../editions/entities/edition.entity';
import { ListReviewsDto, SubmitReviewDto } from './dto/reviews.dto';
import { EventReview } from './entities/event-review.entity';

export interface ReviewItem {
  id: string;
  rating: number;
  comment: string | null;
  createdAt: Date;
  author: { id: string; name: string; avatarUrl: string | null };
  /** True on the caller's own review, so the app can offer edit and delete. */
  mine: boolean;
}

export interface EditionReviews {
  /** Visible reviews in total, not just this page. */
  count: number;
  /** Mean of the visible ratings to one decimal; null when there are none. */
  average: number | null;
  items: ReviewItem[];
  /** The caller's review, even when a moderator has hidden it. */
  mine: ReviewItem | null;
  canReview: boolean;
  /** Why canReview is false, in words the app shows as they are. */
  reason: string | null;
}

export const REVIEWS_NOT_OPEN = 'Reviews open when the event starts';
export const REVIEWS_ATTENDEES_ONLY =
  'Only delegates who attended can review this event';

@Injectable()
export class ReviewsService {
  constructor(
    @InjectRepository(EventReview)
    private readonly reviews: Repository<EventReview>,
    @InjectRepository(Delegate)
    private readonly delegates: Repository<Delegate>,
    private readonly dataSource: DataSource,
    private readonly editions: EditionsService,
    private readonly storage: StorageService,
  ) {}

  async list(
    editionId: string,
    callerId: string,
    query: ListReviewsDto,
  ): Promise<EditionReviews> {
    const edition = await this.editions.findVisible(editionId);
    const where = { editionId, hidden: false };
    const [rows, count] = await this.reviews.findAndCount({
      where,
      order: { createdAt: 'DESC', id: 'ASC' },
      take: query.limit ?? 20,
      skip: query.offset ?? 0,
    });
    const aggregate = await this.reviews
      .createQueryBuilder('r')
      .select('AVG(r.rating)', 'average')
      .where('r.editionId = :editionId', { editionId })
      .andWhere('r.hidden = false')
      .getRawOne<{ average: string | null }>();
    const own = await this.reviews.findOne({
      where: { editionId, delegateId: callerId },
    });
    const eligibility = await this.eligibility(edition, callerId);

    const items = await this.toItems(own ? [...rows, own] : rows, callerId);
    const mine = own ? items.pop()! : null;
    return {
      count,
      average: ReviewsService.average(count, aggregate?.average ?? null),
      items,
      mine,
      ...eligibility,
    };
  }

  /** Upsert: a second review from the same delegate replaces the first. */
  async submit(
    editionId: string,
    callerId: string,
    dto: SubmitReviewDto,
  ): Promise<ReviewItem> {
    const edition = await this.editions.findVisible(editionId);
    const { canReview, reason } = await this.eligibility(edition, callerId);
    if (!canReview) throw new ForbiddenException(reason);

    const comment = dto.comment?.trim() || null;
    const existing = await this.reviews.findOne({
      where: { editionId, delegateId: callerId },
    });
    // an edit keeps `hidden` as the moderator left it: rewording a hidden
    // review must not be a way to publish it again
    const row = existing
      ? Object.assign(existing, { rating: dto.rating, comment })
      : this.reviews.create({
          editionId,
          delegateId: callerId,
          rating: dto.rating,
          comment,
        });
    const saved = await this.reviews.save(row);
    const [item] = await this.toItems([saved], callerId);
    return item;
  }

  /** Idempotent: deleting a review that is not there is not an error. */
  async remove(editionId: string, callerId: string): Promise<void> {
    await this.reviews.delete({ editionId, delegateId: callerId });
  }

  async setHidden(id: string, hidden: boolean): Promise<void> {
    const review = await this.reviews.findOne({ where: { id } });
    if (!review) throw new NotFoundException('Review not found');
    await this.reviews.update({ id }, { hidden });
  }

  /**
   * Who may review: someone who was there, once there was something to be
   * at. "Was there" is a ticket for the edition or a recorded attendance at
   * one of its sessions; a bookmark is only an intention, so it does not
   * count. The clock is checked first so a ticket holder waiting for the
   * doors to open is told when, not that they are not allowed.
   */
  async eligibility(
    edition: Edition,
    callerId: string,
  ): Promise<{ canReview: boolean; reason: string | null }> {
    if (edition.startsAt.getTime() > Date.now()) {
      return { canReview: false, reason: REVIEWS_NOT_OPEN };
    }
    const rows: { attended: boolean }[] = await this.dataSource.query(
      `SELECT (
         EXISTS (SELECT 1 FROM tickets t
                 WHERE t."editionId" = $1 AND t."delegateId" = $2)
         OR EXISTS (SELECT 1 FROM session_attendance a
                    JOIN sessions s ON s.id = a."sessionId"
                    WHERE s."editionId" = $1 AND a."delegateId" = $2)
       ) AS "attended"`,
      [edition.id, callerId],
    );
    return rows[0]?.attended
      ? { canReview: true, reason: null }
      : { canReview: false, reason: REVIEWS_ATTENDEES_ONLY };
  }

  static average(count: number, raw: string | number | null): number | null {
    if (count === 0 || raw === null) return null;
    return Math.round(Number(raw) * 10) / 10;
  }

  /** Reviews with their authors, one delegate lookup for the whole page. */
  private async toItems(
    rows: EventReview[],
    callerId: string,
  ): Promise<ReviewItem[]> {
    const ids = [...new Set(rows.map((r) => r.delegateId))];
    const authors =
      ids.length === 0
        ? []
        : await this.delegates.find({
            where: { id: In(ids) },
            select: { id: true, name: true, avatarUrl: true },
          });
    const byId = new Map(authors.map((a) => [a.id, a]));
    return Promise.all(
      rows.map(async (r) => {
        const author = byId.get(r.delegateId);
        return {
          id: r.id,
          rating: r.rating,
          comment: r.comment,
          createdAt: r.createdAt,
          author: {
            id: r.delegateId,
            // a deleted account's review keeps its stars, not a name
            name: author?.name ?? 'Former delegate',
            avatarUrl: await this.storage.resolveAvatar(
              author?.avatarUrl ?? null,
            ),
          },
          mine: r.delegateId === callerId,
        };
      }),
    );
  }
}
