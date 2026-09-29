import { ConflictException, NotFoundException } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';
import { EditionRoomsService } from './edition-rooms.service';
import type { EditionRoom } from './entities/edition-room.entity';

const room = (over: Partial<EditionRoom>): EditionRoom =>
  ({
    id: 'r',
    editionId: 'e1',
    name: 'Room',
    floor: null,
    notes: null,
    sortOrder: 0,
    ...over,
  }) as EditionRoom;

function build(
  described: EditionRoom[] = [],
  usage: { room: string; count: number }[] = [],
) {
  const repo = {
    find: jest.fn().mockResolvedValue(described),
    findOne: jest.fn(({ where: { id } }: { where: { id: string } }) =>
      Promise.resolve(described.find((r) => r.id === id) ?? null),
    ),
    create: jest.fn((v: Partial<EditionRoom>) => v),
    save: jest.fn((v: EditionRoom) => Promise.resolve(v)),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const dataSource = { query: jest.fn().mockResolvedValue(usage) };
  const service = new EditionRoomsService(
    repo as unknown as Repository<EditionRoom>,
    dataSource as unknown as DataSource,
  );
  return { service, repo, dataSource };
}

describe('EditionRoomsService.list', () => {
  it('merges described rooms with rooms only the programme names', async () => {
    const { service, dataSource } = build(
      [
        room({ id: 'a', name: 'Hall A', floor: 'Ground floor' }),
        room({ id: 'q', name: 'Quiet Room', notes: 'Level 2, by the lifts' }),
      ],
      [
        { room: 'Hall A', count: 3 },
        { room: 'hall  a ', count: 2 },
        { room: 'Banquet Hall', count: 7 },
        { room: 'Room 2B', count: 2 },
      ],
    );
    const rooms = await service.list('e1');

    expect(rooms).toEqual([
      {
        id: null,
        name: 'Banquet Hall',
        floor: null,
        notes: null,
        sessionCount: 7,
      },
      {
        id: 'a',
        name: 'Hall A',
        floor: 'Ground floor',
        notes: null,
        sessionCount: 5,
      },
      {
        id: null,
        name: 'Room 2B',
        floor: null,
        notes: null,
        sessionCount: 2,
      },
      {
        id: 'q',
        name: 'Quiet Room',
        floor: null,
        notes: 'Level 2, by the lifts',
        sessionCount: 0,
      },
    ]);
    const [sql, params] = dataSource.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('"editionId" = $1');
    expect(params).toEqual(['e1']);
  });

  it('breaks count ties by name, ignoring case', async () => {
    const { service } = build(
      [room({ id: 'z', name: 'zeta' })],
      [
        { room: 'Beta', count: 1 },
        { room: 'alpha', count: 1 },
      ],
    );
    const rooms = await service.list('e1');
    expect(rooms.map((r) => r.name)).toEqual(['alpha', 'Beta', 'zeta']);
  });

  it('names an undescribed room by its most used spelling', async () => {
    const { service } = build(
      [],
      [
        { room: 'main hall', count: 1 },
        { room: 'Main Hall', count: 4 },
      ],
    );
    const [only] = await service.list('e1');
    expect(only).toMatchObject({ name: 'Main Hall', sessionCount: 5 });
  });

  it('is empty when there are neither rooms nor sessions', async () => {
    const { service } = build();
    expect(await service.list('e1')).toEqual([]);
  });
});

describe('EditionRoomsService admin', () => {
  it('refuses a second room with the same name in another case or spacing', async () => {
    const { service, repo } = build([room({ id: 'a', name: 'Hall A' })]);
    await expect(
      service.create('e1', { name: ' hall   a ' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('tidies the name and blanks, and appends after the last room', async () => {
    const { service } = build([
      room({ id: 'a', name: 'Hall A', sortOrder: 3 }),
    ]);
    const created = await service.create('e1', {
      name: '  Room   2B ',
      floor: ' ',
      notes: ' Level 2 ',
    });
    expect(created).toMatchObject({
      editionId: 'e1',
      name: 'Room 2B',
      floor: null,
      notes: 'Level 2',
      sortOrder: 4,
    });
  });

  it('allows recasing a room, but not renaming it onto another', async () => {
    const { service } = build([
      room({ id: 'a', name: 'Hall A' }),
      room({ id: 'b', name: 'Hall B' }),
    ]);
    await expect(
      service.update('a', { name: 'HALL A' }),
    ).resolves.toMatchObject({ name: 'HALL A' });
    await expect(
      service.update('a', { name: 'hall b' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('404s an unknown room', async () => {
    const { service, repo } = build();
    await expect(service.update('nope', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    repo.delete.mockResolvedValue({ affected: 0 });
    await expect(service.remove('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
