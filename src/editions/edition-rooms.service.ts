import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  CreateEditionRoomDto,
  UpdateEditionRoomDto,
} from './dto/edition-room.dto';
import { EditionRoom } from './entities/edition-room.entity';

/** One room as the app's venue page lists it. */
export interface EditionRoomView {
  /** Null for a room only the programme names, with no row of its own. */
  id: string | null;
  name: string;
  floor: string | null;
  notes: string | null;
  /** Sessions of this edition held in the room. */
  sessionCount: number;
}

interface SessionRoomRow {
  room: string;
  count: number | string;
}

/** Case- and spacing-insensitive: "Hall  A" and "hall a" are one room. */
export const roomKey = (name: string): string =>
  name.trim().replace(/\s+/g, ' ').toLowerCase();

const tidy = (name: string): string => name.trim().replace(/\s+/g, ' ');

/**
 * Venue rooms per edition. Sessions keep naming their room as free text, so
 * the list is the union of the rooms described here and the rooms the
 * programme uses, matched by name.
 */
@Injectable()
export class EditionRoomsService {
  constructor(
    @InjectRepository(EditionRoom)
    private readonly rooms: Repository<EditionRoom>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Every described room plus any room a session names that is not
   * described yet, each with its session count, busiest first then by name.
   */
  async list(editionId: string): Promise<EditionRoomView[]> {
    const described = await this.rooms.find({ where: { editionId } });
    const usage: SessionRoomRow[] = await this.dataSource.query(
      `SELECT room, COUNT(*)::int AS count FROM sessions
       WHERE "editionId" = $1 AND room IS NOT NULL AND btrim(room) <> ''
       GROUP BY room`,
      [editionId],
    );

    // several spellings of one room collapse into one entry; the most used
    // spelling names an undescribed room
    const counts = new Map<
      string,
      { count: number; name: string; top: number }
    >();
    for (const row of usage) {
      const key = roomKey(row.room);
      const n = Number(row.count);
      const entry = counts.get(key);
      if (!entry) {
        counts.set(key, { count: n, name: tidy(row.room), top: n });
      } else {
        entry.count += n;
        if (n > entry.top) {
          entry.name = tidy(row.room);
          entry.top = n;
        }
      }
    }

    const out: EditionRoomView[] = described.map((r) => ({
      id: r.id,
      name: r.name,
      floor: r.floor,
      notes: r.notes,
      sessionCount: counts.get(roomKey(r.name))?.count ?? 0,
    }));
    const seen = new Set(described.map((r) => roomKey(r.name)));
    for (const [key, entry] of counts) {
      if (seen.has(key)) continue;
      out.push({
        id: null,
        name: entry.name,
        floor: null,
        notes: null,
        sessionCount: entry.count,
      });
    }
    return out.sort(
      (a, b) =>
        b.sessionCount - a.sessionCount ||
        a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }),
    );
  }

  async create(
    editionId: string,
    dto: CreateEditionRoomDto,
  ): Promise<EditionRoom> {
    const name = tidy(dto.name);
    await this.assertNameFree(editionId, name);
    let sortOrder = dto.sortOrder;
    if (sortOrder === undefined) {
      const last = await this.rooms.find({
        where: { editionId },
        order: { sortOrder: 'DESC' },
        take: 1,
      });
      sortOrder = last.length > 0 ? last[0].sortOrder + 1 : 0;
    }
    return this.rooms.save(
      this.rooms.create({
        editionId,
        name,
        floor: dto.floor?.trim() || null,
        notes: dto.notes?.trim() || null,
        sortOrder,
      }),
    );
  }

  async update(id: string, dto: UpdateEditionRoomDto): Promise<EditionRoom> {
    const room = await this.rooms.findOne({ where: { id } });
    if (!room) throw new NotFoundException('Room not found');
    if (dto.name !== undefined) {
      const name = tidy(dto.name);
      if (roomKey(name) !== roomKey(room.name)) {
        await this.assertNameFree(room.editionId, name);
      }
      room.name = name;
    }
    if (dto.floor !== undefined) room.floor = dto.floor?.trim() || null;
    if (dto.notes !== undefined) room.notes = dto.notes?.trim() || null;
    if (dto.sortOrder !== undefined) room.sortOrder = dto.sortOrder;
    return this.rooms.save(room);
  }

  /** Removes the description; sessions naming the room still list it. */
  async remove(id: string): Promise<void> {
    const result = await this.rooms.delete({ id });
    if (!result.affected) throw new NotFoundException('Room not found');
  }

  /**
   * A friendly 409 ahead of the unique index on (editionId, lower(name)),
   * which still catches a race between two console tabs.
   */
  private async assertNameFree(editionId: string, name: string) {
    const existing = await this.rooms.find({ where: { editionId } });
    if (existing.some((r) => roomKey(r.name) === roomKey(name))) {
      throw new ConflictException(`This edition already has a room "${name}"`);
    }
  }
}
