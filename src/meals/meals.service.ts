import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { AdmissionService } from '../ticketing/admission.service';
import { Ticket } from '../ticketing/entities/ticket.entity';
import type {
  CreateCounterDto,
  CreateMealDto,
  ServeDto,
  UpdateMealDto,
} from './dto/meals.dto';
import { MealCounter } from './entities/meal-counter.entity';
import { MealServing } from './entities/meal-serving.entity';
import { Meal } from './entities/meal.entity';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hhmm = (d: Date) =>
  d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Lagos',
  });

export type MealView = Meal & { served: number };
export type CounterView = {
  id: string;
  name: string;
  linkOn: boolean;
  served: number;
};
export type ServeResult = {
  holder: string;
  tier: string;
  seat: number;
  of: number;
  meal: string;
};

/**
 * Meals at an event and the counters that serve them. Catering staff scan the
 * delegate's ticket QR (the signed one, so a photo of a name or a made-up code
 * serves nobody), and each ticket collects each meal once per person on it.
 */
@Injectable()
export class MealsService {
  constructor(
    @InjectRepository(Meal) private readonly meals: Repository<Meal>,
    @InjectRepository(MealCounter)
    private readonly counters: Repository<MealCounter>,
    @InjectRepository(MealServing)
    private readonly servings: Repository<MealServing>,
    private readonly admission: AdmissionService,
    private readonly dataSource: DataSource,
  ) {}

  /* ------------------------------------------------------------- organisers */

  /** The event's meals in serving order, each with how many plates have gone out. */
  async list(
    editionId: string,
  ): Promise<{ meals: MealView[]; counters: CounterView[]; people: number }> {
    const meals = await this.meals.find({
      where: { editionId },
      order: { startsAt: 'ASC' },
    });
    const served = await this.countBy(
      '"mealId"',
      meals.map((m) => m.id),
    );
    const counters = await this.counters
      .createQueryBuilder('c')
      .addSelect('c.keyHash')
      .where('c.editionId = :editionId', { editionId })
      .orderBy('c.createdAt', 'ASC')
      .getMany();
    const byCounter = await this.countBy(
      '"counterId"',
      counters.map((c) => c.id),
    );
    const [row]: { people: number | string | null }[] =
      await this.dataSource.query(
        `SELECT COALESCE(SUM(quantity), 0) AS people FROM tickets WHERE "editionId" = $1`,
        [editionId],
      );
    return {
      meals: meals.map((m) => ({ ...m, served: served.get(m.id) ?? 0 })),
      counters: counters.map((c) => ({
        id: c.id,
        name: c.name,
        linkOn: !!c.keyHash,
        served: byCounter.get(c.id) ?? 0,
      })),
      people: Number(row?.people ?? 0),
    };
  }

  async create(dto: CreateMealDto): Promise<Meal> {
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    MealsService.assertWindow(startsAt, endsAt);
    return this.meals.save(
      this.meals.create({
        editionId: dto.editionId,
        name: dto.name.trim(),
        startsAt,
        endsAt,
      }),
    );
  }

  async update(id: string, dto: UpdateMealDto): Promise<Meal> {
    const meal = await this.meal(id);
    if (dto.name !== undefined) meal.name = dto.name.trim();
    if (dto.startsAt) meal.startsAt = new Date(dto.startsAt);
    if (dto.endsAt) meal.endsAt = new Date(dto.endsAt);
    MealsService.assertWindow(meal.startsAt, meal.endsAt);
    return this.meals.save(meal);
  }

  /** A meal nobody has been served yet. Once plates have gone out, its record stays. */
  async remove(id: string): Promise<void> {
    const meal = await this.meal(id);
    const served = await this.servings.countBy({ mealId: id });
    if (served > 0) {
      throw new ConflictException(
        `${served} ${served === 1 ? 'person has' : 'people have'} already collected "${meal.name}", so it stays as the record. Change its times instead.`,
      );
    }
    await this.meals.delete({ id });
  }

  async createCounter(
    dto: CreateCounterDto,
  ): Promise<{ counter: CounterView; key: string }> {
    const counter = await this.counters.save(
      this.counters.create({
        editionId: dto.editionId,
        name: dto.name.trim(),
        keyHash: null,
      }),
    );
    const key = await this.issueKey(counter.id);
    return {
      counter: { id: counter.id, name: counter.name, linkOn: true, served: 0 },
      key,
    };
  }

  /** A new link for the counter; the old one stops working at once. */
  async issueKey(counterId: string): Promise<string> {
    await this.counter(counterId);
    const secret = randomBytes(24).toString('base64url');
    await this.counters.update({ id: counterId }, { keyHash: sha256(secret) });
    return `${counterId}.${secret}`;
  }

  /** Switches the counter's link off. */
  async revokeKey(counterId: string): Promise<void> {
    await this.counter(counterId);
    await this.counters.update({ id: counterId }, { keyHash: null });
  }

  /** Removes a counter; the plates it served stay counted under their meals. */
  async removeCounter(counterId: string): Promise<void> {
    await this.counter(counterId);
    await this.counters.delete({ id: counterId });
  }

  /* ------------------------------------------------------------- counters */

  /** The counter a link opens, or 401: the same answer for a wrong, revoked or malformed key. */
  async counterForKey(header: string | undefined): Promise<MealCounter> {
    const [id, secret] = (header ?? '').trim().split('.');
    const refuse = () =>
      new UnauthorizedException(
        'This counter link is not valid any more. Ask the organisers for a new one.',
      );
    if (!id || !secret || !UUID.test(id)) throw refuse();
    const counter = await this.counters
      .createQueryBuilder('c')
      .addSelect('c.keyHash')
      .where('c.id = :id', { id })
      .getOne();
    if (
      !counter?.keyHash ||
      !timingSafeEqual(
        Buffer.from(sha256(secret)),
        Buffer.from(counter.keyHash),
      )
    )
      throw refuse();
    return counter;
  }

  /** What the counter page shows: the counter, its event's meals and which is being served now. */
  async counterView(counter: MealCounter, now = new Date()) {
    const [edition]: { name: string; shortName: string }[] =
      await this.dataSource.query(
        `SELECT name, "shortName" FROM editions WHERE id = $1`,
        [counter.editionId],
      );
    const meals = await this.meals.find({
      where: { editionId: counter.editionId },
      order: { startsAt: 'ASC' },
    });
    const served = await this.countBy(
      '"mealId"',
      meals.map((m) => m.id),
    );
    return {
      counter: { id: counter.id, name: counter.name },
      edition: {
        name: edition?.name ?? '',
        shortName: edition?.shortName ?? '',
      },
      meals: meals.map((m) => ({
        id: m.id,
        name: m.name,
        startsAt: m.startsAt,
        endsAt: m.endsAt,
        open: m.startsAt <= now && now < m.endsAt,
        served: served.get(m.id) ?? 0,
      })),
    };
  }

  /**
   * Serves one plate on the scanned ticket. Refused when the ticket is for
   * another event, the meal is not being served now, or everyone on the
   * ticket has already collected this meal: the refusal says when and where.
   */
  async serve(
    counter: MealCounter,
    dto: ServeDto,
    now = new Date(),
  ): Promise<ServeResult> {
    const meal = await this.meals.findOneBy({ id: dto.mealId });
    if (!meal || meal.editionId !== counter.editionId)
      throw new NotFoundException('That meal is not on at this event.');
    if (now < meal.startsAt || now >= meal.endsAt) {
      throw new BadRequestException(
        `${meal.name} is served ${hhmm(meal.startsAt)}–${hhmm(meal.endsAt)}, not now.`,
      );
    }
    const ticket = await this.ticketFor(dto, counter.editionId);
    const of = Math.max(1, ticket.quantity);
    const before = await this.servings.find({
      where: { mealId: meal.id, ticketId: ticket.id },
      order: { servedAt: 'DESC' },
    });
    if (before.length >= of)
      throw await this.alreadyServed(ticket, meal, before[0]);
    try {
      await this.servings.insert({
        mealId: meal.id,
        ticketId: ticket.id,
        seat: before.length + 1,
        counterId: counter.id,
      });
    } catch (e) {
      // two counters scanned the same ticket at the same moment: the other one won
      if (e instanceof QueryFailedError) {
        const latest = await this.servings.findOne({
          where: { mealId: meal.id, ticketId: ticket.id },
          order: { servedAt: 'DESC' },
        });
        throw await this.alreadyServed(ticket, meal, latest!);
      }
      throw e;
    }
    return {
      holder: ticket.guestName,
      tier: ticket.tierName,
      seat: before.length + 1,
      of,
      meal: meal.name,
    };
  }

  private async ticketFor(dto: ServeDto, editionId: string): Promise<Ticket> {
    const tickets = this.dataSource.getRepository(Ticket);
    let ticket: Ticket | null = null;
    if (dto.qr?.trim()) {
      const id = await this.admission.verify(dto.qr.trim());
      if (!id)
        throw new NotFoundException(
          'That is not a PIC Events ticket. Scan the QR on the ticket in the app or on the badge.',
        );
      ticket = await tickets.findOneBy({ id });
    } else if (dto.code?.trim()) {
      ticket = await tickets.findOneBy({
        code: dto.code.trim().toUpperCase(),
        editionId,
      });
      if (!ticket)
        throw new NotFoundException(
          'No ticket at this event has that code. Check it and try again.',
        );
    } else {
      throw new BadRequestException('Scan a ticket, or type its code.');
    }
    if (!ticket) throw new NotFoundException('That ticket no longer exists.');
    if (ticket.editionId !== editionId)
      throw new BadRequestException('That ticket is for a different event.');
    return ticket;
  }

  private async alreadyServed(ticket: Ticket, meal: Meal, last: MealServing) {
    const where = last.counterId
      ? (await this.counters.findOneBy({ id: last.counterId }))?.name
      : null;
    return new ConflictException(
      `${ticket.guestName} already collected ${meal.name} at ${hhmm(last.servedAt)}${where ? ` (${where})` : ''}.`,
    );
  }

  /* ------------------------------------------------------------- helpers */

  private async meal(id: string): Promise<Meal> {
    const meal = await this.meals.findOneBy({ id });
    if (!meal) throw new NotFoundException('Meal not found');
    return meal;
  }

  private async counter(id: string): Promise<MealCounter> {
    const counter = await this.counters.findOneBy({ id });
    if (!counter) throw new NotFoundException('Counter not found');
    return counter;
  }

  private async countBy(
    column: '"mealId"' | '"counterId"',
    ids: string[],
  ): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const rows: { id: string; n: number | string }[] =
      await this.dataSource.query(
        `SELECT ${column} AS id, COUNT(*)::int AS n FROM meal_servings WHERE ${column} = ANY($1) GROUP BY ${column}`,
        [ids],
      );
    return new Map(rows.map((r) => [r.id, Number(r.n)]));
  }

  static assertWindow(startsAt: Date, endsAt: Date) {
    if (!(endsAt > startsAt))
      throw new BadRequestException('Serving has to end after it starts.');
  }
}
