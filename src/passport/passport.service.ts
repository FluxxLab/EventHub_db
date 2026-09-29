import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomInt } from 'crypto';
import { DataSource, In, Repository } from 'typeorm';
import { EditionsService } from '../editions/editions.service';
import { CreateBoothDto, UpdateBoothDto } from './dto/passport.dto';
import { BoothStamp } from './entities/booth-stamp.entity';
import { Booth } from './entities/booth.entity';

/**
 * No 0/O/1/I: the code is read off a sign and typed on a phone, and those
 * pairs are the ones people get wrong.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
export const MAX_DRAW = 20;

export interface PassportBoothView {
  id: string;
  name: string;
  location: string | null;
  description: string | null;
  stamped: boolean;
  stampedAt: string | null;
}

export interface PassportView {
  editionId: string;
  booths: PassportBoothView[];
  stamped: number;
  total: number;
  complete: boolean;
}

export interface StampResult extends PassportView {
  booth: { id: string; name: string };
  alreadyStamped: boolean;
}

export interface BoothAdminView {
  id: string;
  name: string;
  code: string;
  location: string | null;
  isActive: boolean;
  sortOrder: number;
  stamps: number;
}

export interface DrawEntry {
  id: string;
  name: string;
  email: string;
  organisation: string | null;
  completedAt: string;
}

/** COUNT(*) comes back from Postgres as a bigint, so a string. */
interface StampCountRow {
  boothId: string;
  count: string;
}

interface DrawRow {
  id: string;
  name: string;
  email: string;
  organisation: string | null;
  completedAt: Date;
}

@Injectable()
export class PassportService {
  constructor(
    @InjectRepository(Booth)
    private readonly booths: Repository<Booth>,
    @InjectRepository(BoothStamp)
    private readonly stamps: Repository<BoothStamp>,
    private readonly dataSource: DataSource,
    private readonly editions: EditionsService,
  ) {}

  /* ---------------------------------------------------------------- delegate */

  /**
   * The delegate's passport page: every active stand of the edition and
   * which ones they have visited. Defaults to the current edition, which is
   * the only one with stands on the floor.
   */
  async view(delegateId: string, editionId?: string): Promise<PassportView> {
    const resolved = editionId ?? (await this.editions.current())?.id;
    if (!resolved) throw new NotFoundException('No edition is current');

    const booths = await this.booths.find({
      where: { editionId: resolved, isActive: true },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
    const mine =
      booths.length === 0
        ? []
        : await this.stamps.find({
            where: { delegateId, boothId: In(booths.map((b) => b.id)) },
          });
    const stampedAt = new Map(mine.map((s) => [s.boothId, s.createdAt]));

    const views = booths.map((b) => {
      const at = stampedAt.get(b.id);
      return {
        id: b.id,
        name: b.name,
        location: b.location,
        description: b.description,
        stamped: at !== undefined,
        stampedAt: at?.toISOString() ?? null,
      };
    });
    const stamped = views.filter((v) => v.stamped).length;
    return {
      editionId: resolved,
      booths: views,
      stamped,
      total: views.length,
      // an edition with no stands yet is not "complete", it is empty
      complete: views.length > 0 && stamped === views.length,
    };
  }

  /**
   * Stamp the stand whose code was scanned or typed. A repeat scan is
   * reported rather than refused: the delegate sees "already stamped" and
   * their passport, not an error for doing the right thing twice.
   */
  async stamp(delegateId: string, rawCode: string): Promise<StampResult> {
    const code = rawCode.trim().toUpperCase();
    const booth = await this.booths.findOne({ where: { code } });
    // an inactive stand is indistinguishable from a wrong code on purpose
    if (!booth || !booth.isActive) {
      throw new NotFoundException('That booth code is not recognised');
    }

    const result = await this.stamps
      .createQueryBuilder()
      .insert()
      .into(BoothStamp)
      .values({ boothId: booth.id, delegateId })
      .orIgnore()
      .execute();
    const alreadyStamped = result.identifiers.length === 0;

    const passport = await this.view(delegateId, booth.editionId);
    return {
      ...passport,
      booth: { id: booth.id, name: booth.name },
      alreadyStamped,
    };
  }

  /* ------------------------------------------------------------------- admin */

  async createBooth(editionId: string, dto: CreateBoothDto): Promise<Booth> {
    await this.editions.findById(editionId);
    return this.booths.save(
      this.booths.create({
        editionId,
        name: dto.name.trim(),
        code: await this.uniqueCode(),
        description: dto.description?.trim() || null,
        location: dto.location?.trim() || null,
        sortOrder: dto.sortOrder ?? 0,
        isActive: true,
      }),
    );
  }

  async updateBooth(id: string, dto: UpdateBoothDto): Promise<Booth> {
    const booth = await this.findBooth(id);
    Object.assign(booth, {
      ...(dto.name !== undefined && { name: dto.name.trim() }),
      ...(dto.description !== undefined && {
        description: dto.description.trim() || null,
      }),
      ...(dto.location !== undefined && {
        location: dto.location.trim() || null,
      }),
      ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
      ...(dto.isActive !== undefined && { isActive: dto.isActive }),
    });
    return this.booths.save(booth);
  }

  /** Removes the stand and its stamps; nobody's passport should list a stand that is gone. */
  async removeBooth(id: string): Promise<void> {
    await this.findBooth(id);
    await this.stamps.delete({ boothId: id });
    await this.booths.delete({ id });
  }

  async listBooths(editionId: string): Promise<BoothAdminView[]> {
    await this.editions.findById(editionId);
    const booths = await this.booths.find({
      where: { editionId },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
    if (booths.length === 0) return [];

    const rows = await this.stamps
      .createQueryBuilder('s')
      .select('s.boothId', 'boothId')
      .addSelect('COUNT(*)', 'count')
      .where('s.boothId IN (:...ids)', { ids: booths.map((b) => b.id) })
      .groupBy('s.boothId')
      .getRawMany<StampCountRow>();
    const counts = new Map(rows.map((r) => [r.boothId, Number(r.count)]));

    return booths.map((b) => ({
      id: b.id,
      name: b.name,
      code: b.code,
      location: b.location,
      isActive: b.isActive,
      sortOrder: b.sortOrder,
      stamps: counts.get(b.id) ?? 0,
    }));
  }

  /**
   * Prize draw: `count` random delegates who have stamped every active
   * stand. Done in SQL so the pool is never loaded into memory and the pick
   * is Postgres' random(), not a JS shuffle over a partial page.
   */
  async draw(editionId: string, count: number): Promise<DrawEntry[]> {
    await this.editions.findById(editionId);
    const active = await this.booths.find({
      where: { editionId, isActive: true },
      select: { id: true },
    });
    if (active.length === 0) return [];

    const rows: DrawRow[] = await this.dataSource.query(
      `SELECT d."id", d."name", d."email", d."organisation", c."completedAt"
       FROM (
         SELECT s."delegateId", MAX(s."createdAt") AS "completedAt"
         FROM "booth_stamps" s
         WHERE s."boothId" = ANY($1::uuid[])
         GROUP BY s."delegateId"
         HAVING COUNT(DISTINCT s."boothId") = $2
       ) c
       JOIN "delegates" d ON d."id" = c."delegateId"
       ORDER BY random()
       LIMIT $3`,
      [
        active.map((b) => b.id),
        active.length,
        Math.min(Math.max(count, 1), MAX_DRAW),
      ],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      organisation: r.organisation,
      completedAt: new Date(r.completedAt).toISOString(),
    }));
  }

  /* --------------------------------------------------------------- internals */

  private async findBooth(id: string): Promise<Booth> {
    const booth = await this.booths.findOne({ where: { id } });
    if (!booth) throw new NotFoundException('Booth not found');
    return booth;
  }

  /**
   * 32^6 codes make a clash unlikely, but a stand's code is printed once and
   * must be right, so check before saving; the unique index is the backstop.
   */
  private async uniqueCode(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i += 1) {
        code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      }
      if (!(await this.booths.existsBy({ code }))) return code;
    }
    throw new Error('Could not allocate a unique booth code');
  }
}
