import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { QueryFailedError } from 'typeorm';
import { MealsService } from './meals.service';

/**
 * Serving meals: each person on a ticket collects each meal once, only while
 * it is being served, and only at the event the ticket is for.
 */
const EDITION = 'e0000000-0000-4000-8000-000000000001';
const MEAL = {
  id: 'm1',
  editionId: EDITION,
  name: 'Lunch, Day 1',
  startsAt: new Date('2027-09-07T11:00:00Z'),
  endsAt: new Date('2027-09-07T13:00:00Z'),
};
const NOW = new Date('2027-09-07T12:00:00Z');
const COUNTER = { id: 'c1', editionId: EDITION, name: 'Hall B', keyHash: null };

function build({
  quantity = 1,
  served = [] as { servedAt: Date; counterId: string | null }[],
  ticketEdition = EDITION,
  insertFails = false,
} = {}) {
  const ticket = {
    id: 't1',
    editionId: ticketEdition,
    guestName: 'Hauwa Bello',
    tierName: 'Delegate',
    quantity,
    code: 'PIC-DEL-1234',
  };
  const meals = { findOneBy: jest.fn().mockResolvedValue(MEAL) };
  const counters = {
    findOneBy: jest.fn().mockResolvedValue(COUNTER),
    createQueryBuilder: jest.fn(),
  };
  const servings = {
    find: jest.fn().mockResolvedValue(served),
    findOne: jest.fn().mockResolvedValue({
      servedAt: new Date('2027-09-07T11:58:00Z'),
      counterId: 'c1',
    }),
    insert: insertFails
      ? jest
          .fn()
          .mockRejectedValue(
            new QueryFailedError('insert', [], new Error('duplicate key')),
          )
      : jest.fn().mockResolvedValue({}),
    countBy: jest.fn(),
  };
  const admission = { verify: jest.fn().mockResolvedValue('t1') };
  const dataSource = {
    getRepository: () => ({ findOneBy: jest.fn().mockResolvedValue(ticket) }),
    query: jest.fn(),
  };
  const service = new MealsService(
    meals as never,
    counters as never,
    servings as never,
    admission as never,
    dataSource as never,
  );
  return { service, servings, admission, counters };
}

describe('MealsService.serve', () => {
  const serve = (s: MealsService, over: object = {}, now = NOW) =>
    s.serve(COUNTER as never, { mealId: 'm1', qr: 'PICT1.x.y', ...over }, now);

  it('serves a delegate once, naming them for the counter', async () => {
    const { service, servings } = build();
    await expect(serve(service)).resolves.toEqual({
      holder: 'Hauwa Bello',
      tier: 'Delegate',
      seat: 1,
      of: 1,
      meal: 'Lunch, Day 1',
    });
    expect(servings.insert).toHaveBeenCalledWith({
      mealId: 'm1',
      ticketId: 't1',
      seat: 1,
      counterId: 'c1',
    });
  });

  it('refuses a second collection, saying when and where the first was', async () => {
    const { service, servings } = build({
      served: [{ servedAt: new Date('2027-09-07T11:58:00Z'), counterId: 'c1' }],
    });
    await expect(serve(service)).rejects.toThrow(
      /Hauwa Bello already collected Lunch, Day 1 at \d{2}:\d{2} \(Hall B\)/,
    );
    expect(servings.insert).not.toHaveBeenCalled();
  });

  it('lets a ticket for three people collect three plates, then stops', async () => {
    const two = [
      { servedAt: NOW, counterId: 'c1' },
      { servedAt: NOW, counterId: 'c1' },
    ];
    await expect(
      serve(build({ quantity: 3, served: two }).service),
    ).resolves.toMatchObject({ seat: 3, of: 3 });
    await expect(
      serve(
        build({ quantity: 3, served: [...two, ...two.slice(0, 1)] }).service,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses when two counters race for the same plate', async () => {
    await expect(
      serve(build({ insertFails: true }).service),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses outside the serving window and at the wrong event', async () => {
    await expect(
      serve(build().service, {}, new Date('2027-09-07T14:00:00Z')),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      serve(build({ ticketEdition: 'other' }).service),
    ).rejects.toThrow('different event');
  });

  it('refuses a QR that is not a signed ticket', async () => {
    const { service, admission } = build();
    admission.verify.mockResolvedValue(null);
    await expect(serve(service)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('MealsService.counterForKey', () => {
  it('opens the counter for its key and refuses anything else alike', async () => {
    const { service, counters } = build();
    const secret = 's3cret';
    const qb = {
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue({
        ...COUNTER,
        id: '11111111-1111-4111-8111-111111111111',
        keyHash: createHash('sha256').update(secret).digest('hex'),
      }),
    };
    counters.createQueryBuilder.mockReturnValue(qb);
    await expect(
      service.counterForKey(`11111111-1111-4111-8111-111111111111.${secret}`),
    ).resolves.toMatchObject({ name: 'Hall B' });
    await expect(
      service.counterForKey('11111111-1111-4111-8111-111111111111.wrong'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.counterForKey(undefined)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
