import type { CatalogService } from '../catalog/catalog.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { EditionsService } from './editions.service';
import {
  CentreAction,
  DEFAULT_EDITION_FEATURES,
  DEFAULT_TICKET_TERMS,
  Edition,
  EditionCategory,
  EditionStatus,
} from './entities/edition.entity';
import type { StorageService } from '../common/storage/storage.service';
import type Redis from 'ioredis';

/**
 * The edition decides what the whole app shows, so the cases that matter are
 * the ones where it shows the wrong thing: a draft leaking next year's dates,
 * a window where no edition is current, and an edition that ends before it
 * begins.
 */
const edition = (over: Partial<Edition> = {}): Edition =>
  ({
    id: 'gs27',
    name: 'GS-27 Gender and Inclusion Summit',
    shortName: 'GS-27',
    startsAt: new Date('2027-09-07T08:00:00+01:00'),
    endsAt: new Date('2027-09-08T17:00:00+01:00'),
    venue: 'Abuja, Nigeria',
    status: EditionStatus.ANNOUNCED,
    registrationOpen: false,
    isCurrent: true,
    centreAction: CentreAction.QR,
    centreLabel: null,
    mutedNotifications: [],
    category: EditionCategory.SUMMITS,
    city: 'Abuja',
    coverImage: null,
    description: null,
    latitude: null,
    longitude: null,
    features: [...DEFAULT_EDITION_FEATURES],
    info: null,
    ...over,
  }) as Edition;

function build(row: Edition | null = edition()) {
  const repo = {
    findOne: jest.fn().mockResolvedValue(row),
    find: jest.fn().mockResolvedValue(row ? [row] : []),
    create: jest.fn().mockImplementation((v: Partial<Edition>) => v),
    save: jest.fn().mockImplementation((v: Edition) => Promise.resolve(v)),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const dataSource = {
    transaction: jest
      .fn()
      .mockImplementation((run: (m: unknown) => unknown) =>
        run({ getRepository: () => repo }),
      ),
    query: jest.fn().mockResolvedValue([]),
  };
  const storage = {
    resolveStoredUrl: jest
      .fn()
      .mockImplementation((v: string | null) => Promise.resolve(v)),
    resolveAvatar: jest
      .fn()
      .mockImplementation((v: string | null) => Promise.resolve(v)),
  };
  // an empty cache by default, so every existing case sees the database
  const cache = new Map<string, string>();
  const pipeline: { set: jest.Mock; exec: jest.Mock } = {
    set: jest.fn((key: string, value: string) => {
      cache.set(key, value);
      return pipeline;
    }),
    exec: jest.fn().mockResolvedValue([]),
  };
  const redis = {
    mget: jest.fn((keys: string[]) =>
      Promise.resolve(keys.map((k) => cache.get(k) ?? null)),
    ),
    pipeline: jest.fn(() => pipeline),
  };
  // every library value is known; the catalog's own spec covers the checks
  const catalog = {
    defaultTopics: jest.fn().mockResolvedValue({
      trackValues: ['digital', 'health'],
      interestValues: ['Policy'],
    }),
    cleanTopics: jest.fn((requested: Record<string, unknown>) =>
      Promise.resolve(
        Object.fromEntries(
          Object.entries(requested).filter(([, v]) => v !== undefined),
        ),
      ),
    ),
  };
  const service = new EditionsService(
    repo as unknown as Repository<Edition>,
    dataSource as unknown as DataSource,
    storage as unknown as StorageService,
    redis as unknown as Redis,
    catalog as unknown as CatalogService,
  );
  return {
    service,
    repo,
    dataSource,
    storage,
    redis,
    pipeline,
    cache,
    catalog,
  };
}

describe('EditionsService.categories', () => {
  it('counts past editions and borrows the latest past cover when nothing is upcoming', async () => {
    const { service, repo, storage } = build();
    repo.find.mockResolvedValue([
      edition({
        id: 'r1',
        category: EditionCategory.ROUNDTABLES,
        startsAt: new Date('2024-03-01T09:00:00Z'),
        endsAt: new Date('2024-03-01T17:00:00Z'),
        coverImage: 'edition-covers/r1',
      }),
      edition({
        id: 'r2',
        category: EditionCategory.ROUNDTABLES,
        startsAt: new Date('2025-03-01T09:00:00Z'),
        endsAt: new Date('2025-03-01T17:00:00Z'),
        coverImage: 'edition-covers/r2',
      }),
    ]);
    storage.resolveStoredUrl.mockImplementation((key: string) =>
      Promise.resolve(`https://signed/${key}`),
    );
    const tiles = await service.categories();
    const roundtables = tiles.find(
      (t) => t.category === EditionCategory.ROUNDTABLES,
    )!;
    expect(roundtables).toMatchObject({
      upcomingCount: 0,
      pastCount: 2,
      coverUrl: 'https://signed/edition-covers/r2',
    });
    expect(
      tiles.find((t) => t.category === EditionCategory.SUMMITS)!.pastCount,
    ).toBe(0);
  });

  it('returns every category with its upcoming count and the soonest cover', async () => {
    const { service, repo, storage } = build();
    repo.find.mockResolvedValue([
      edition({
        id: 'old',
        endsAt: new Date('2020-01-02T17:00:00Z'),
        category: EditionCategory.SUMMITS,
      }),
      edition({ id: 'a', category: EditionCategory.SUMMITS, coverImage: null }),
      edition({
        id: 'b',
        category: EditionCategory.SUMMITS,
        coverImage: 'edition-covers/b',
      }),
      edition({ id: 'w', category: EditionCategory.WORKSHOPS }),
    ]);
    storage.resolveStoredUrl.mockResolvedValue('https://signed/b');
    const tiles = await service.categories();
    expect(tiles).toHaveLength(Object.values(EditionCategory).length);
    const summits = tiles.find((t) => t.category === EditionCategory.SUMMITS)!;
    expect(summits.upcomingCount).toBe(2);
    expect(summits.pastCount).toBe(1);
    expect(summits.coverUrl).toBe('https://signed/b');
    expect(
      tiles.find((t) => t.category === EditionCategory.WORKSHOPS)!
        .upcomingCount,
    ).toBe(1);
    expect(
      tiles.find((t) => t.category === EditionCategory.COMMUNITY)!
        .upcomingCount,
    ).toBe(0);
  });
});

describe('EditionsService.home', () => {
  const past = edition({
    id: 'gs26',
    shortName: 'GS-26',
    startsAt: new Date('2020-01-01T08:00:00Z'),
    endsAt: new Date('2020-01-02T17:00:00Z'),
    status: EditionStatus.ENDED,
  });
  const soon = edition({ id: 'gs27', shortName: 'GS-27' });
  const later = edition({
    id: 'yis27',
    shortName: 'YIS-27',
    startsAt: new Date('2027-11-01T08:00:00Z'),
    endsAt: new Date('2027-11-02T17:00:00Z'),
  });

  it('lists upcoming editions by date and ranks popular by audience', async () => {
    const { service, repo, dataSource } = build();
    repo.find.mockResolvedValue([past, soon, later]);
    dataSource.query
      .mockResolvedValueOnce([{ editionId: 'yis27', count: 40 }])
      .mockResolvedValueOnce([
        { editionId: 'yis27', id: 'd1', name: 'Ada', avatarUrl: null },
      ]);
    const feed = await service.home();
    expect(feed.upcoming.map((c) => c.id)).toEqual(['gs27', 'yis27']);
    expect(feed.popular.map((c) => c.id)).toEqual(['yis27', 'gs27']);
    expect(feed.popular[0].attendeeCount).toBe(40);
    expect(feed.popular[0].attendeePreview).toEqual([
      { editionId: 'yis27', id: 'd1', name: 'Ada', avatarUrl: null },
    ]);
    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({ order: { startsAt: 'ASC' } }),
    );
  });

  it('falls back to the latest ended editions when nothing is upcoming', async () => {
    const { service, repo } = build();
    repo.find.mockResolvedValue([past]);
    const feed = await service.home();
    expect(feed.upcoming).toEqual([]);
    expect(feed.popular.map((c) => c.id)).toEqual(['gs26']);
  });

  it('resolves cover artwork through storage', async () => {
    const { service, repo, storage } = build();
    repo.find.mockResolvedValue([
      edition({ coverImage: 'edition-covers/abc' }),
    ]);
    storage.resolveStoredUrl.mockResolvedValue('https://signed/abc');
    const feed = await service.home();
    expect(feed.upcoming[0].coverUrl).toBe('https://signed/abc');
  });

  it('carries features and help info on every card', async () => {
    // the app decides which tabs to draw from the card, before any other call
    const { service, repo } = build();
    repo.find.mockResolvedValue([
      edition({
        features: ['schedule', 'captions'],
        info: { wifi: { network: 'GS27' } },
      }),
    ]);
    const feed = await service.home();
    expect(feed.upcoming[0].features).toEqual(['schedule', 'captions']);
    expect(feed.upcoming[0].info).toEqual({ wifi: { network: 'GS27' } });
  });
});

describe('EditionsService.card', () => {
  it('includes features and info, null info when unset', async () => {
    const { service } = build();
    const card = await service.card('gs27');
    expect(card.features).toEqual(DEFAULT_EDITION_FEATURES);
    expect(card.info).toBeNull();
  });

  it('carries coordinates, and no reviews as zero and null', async () => {
    const { service } = build(edition({ latitude: 9.06, longitude: 7.5 }));
    const card = await service.card('gs27');
    expect(card).toMatchObject({
      latitude: 9.06,
      longitude: 7.5,
      reviewCount: 0,
      rating: null,
    });
    expect(card).not.toHaveProperty('distanceKm');
  });

  it('rounds the visible-review average to one decimal', async () => {
    const { service, dataSource } = build();
    dataSource.query
      .mockResolvedValueOnce([]) // audience count
      .mockResolvedValueOnce([]) // audience preview
      .mockResolvedValueOnce([
        { editionId: 'gs27', count: 3, average: '4.3333333333' },
      ]);
    const card = await service.card('gs27');
    expect(card.reviewCount).toBe(3);
    expect(card.rating).toBe(4.3);
    const [ratingSql] = dataSource.query.mock.calls[2] as [string];
    expect(ratingSql).toContain('hidden = false');
  });

  it('counts ticket holders in the audience, and keeps unclaimed holders out of the avatars', async () => {
    const { service, dataSource } = build();
    await service.card('gs27');
    const [countSql] = dataSource.query.mock.calls[0] as [string];
    expect(countSql).toContain('FROM tickets t');
    expect(countSql).toContain('session_bookmarks');
    expect(countSql).toContain('session_attendance');
    const [previewSql, params] = dataSource.query.mock.calls[1] as [
      string,
      unknown[],
    ];
    expect(previewSql).toContain('d.flagged = false');
    expect(params).toEqual([
      ['gs27'],
      'ticket-holder',
      'admin',
      'session_admin',
    ]);
  });

  it('404s a draft', async () => {
    const { service } = build(edition({ status: EditionStatus.DRAFT }));
    await expect(service.card('gs27')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('EditionsService.browse nearby', () => {
  // from central Abuja: Kaduna is ~160km, Lagos ~525km
  const abuja = { lat: 9.0579, lng: 7.4951 };
  const lagos = edition({
    id: 'lagos',
    latitude: 6.5244,
    longitude: 3.3792,
    startsAt: new Date('2027-09-01T08:00:00Z'),
  });
  const kaduna = edition({
    id: 'kaduna',
    latitude: 10.5105,
    longitude: 7.4165,
    startsAt: new Date('2027-10-01T08:00:00Z'),
  });
  const unpinnedLate = edition({
    id: 'nowhere-late',
    startsAt: new Date('2027-12-01T08:00:00Z'),
    endsAt: new Date('2027-12-02T08:00:00Z'),
  });
  const unpinnedEarly = edition({
    id: 'nowhere-early',
    startsAt: new Date('2027-08-01T08:00:00Z'),
  });

  it('orders by distance, unpinned editions last by date, each with distanceKm', async () => {
    const { service, repo } = build();
    repo.find.mockResolvedValue([unpinnedEarly, lagos, kaduna, unpinnedLate]);
    const list = await service.browse({ sort: 'nearby', ...abuja });
    expect(list.map((c) => c.id)).toEqual([
      'kaduna',
      'lagos',
      'nowhere-early',
      'nowhere-late',
    ]);
    expect(list[0].distanceKm).toBeGreaterThan(150);
    expect(list[0].distanceKm).toBeLessThan(175);
    // one decimal
    expect(Number.isInteger(list[0].distanceKm! * 10)).toBe(true);
    expect(list[2].distanceKm).toBeNull();
    expect(list[3].distanceKm).toBeNull();
  });

  it('refuses sort=nearby without both lat and lng', async () => {
    const { service } = build();
    await expect(
      service.browse({ sort: 'nearby', lat: 9 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.browse({ sort: 'nearby' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('adds no distance on the other sorts', async () => {
    const { service, repo } = build();
    repo.find.mockResolvedValue([lagos]);
    const [card] = await service.browse({ lat: 9, lng: 7 });
    expect(card).not.toHaveProperty('distanceKm');
  });
});

describe('EditionsService coordinates', () => {
  const base = {
    name: 'GS-27',
    shortName: 'GS-27',
    startsAt: '2027-09-07T08:00:00+01:00',
    endsAt: '2027-09-08T17:00:00+01:00',
  };

  it('stores both coordinates on create', async () => {
    const { service } = build();
    const created = await service.create({
      ...base,
      latitude: 9.0579,
      longitude: 7.4951,
    });
    expect(created.latitude).toBe(9.0579);
    expect(created.longitude).toBe(7.4951);
  });

  it('refuses half a coordinate on create and update', async () => {
    const { service } = build();
    await expect(service.create({ ...base, latitude: 9.0579 })).rejects.toThrow(
      'Give both latitude and longitude',
    );
    await expect(service.update('gs27', { longitude: 7.4951 })).rejects.toThrow(
      'Give both latitude and longitude',
    );
    await expect(
      service.update('gs27', { latitude: null, longitude: 7.4951 }),
    ).rejects.toThrow('Give both latitude and longitude');
  });

  it('clears both with null, and leaves them alone when neither is sent', async () => {
    const cleared = build(edition({ latitude: 9, longitude: 7 }));
    const a = await cleared.service.update('gs27', {
      latitude: null,
      longitude: null,
    });
    expect(a.latitude).toBeNull();
    expect(a.longitude).toBeNull();

    const kept = build(edition({ latitude: 9, longitude: 7 }));
    const b = await kept.service.update('gs27', { city: 'Lagos' });
    expect(b.latitude).toBe(9);
    expect(b.longitude).toBe(7);
  });
});

describe('EditionsService.current', () => {
  it('returns the current edition', async () => {
    const { service } = build();
    expect((await service.current())?.shortName).toBe('GS-27');
  });

  it('returns null between summits, which the app has to render', async () => {
    const { service } = build(null);
    expect(await service.current()).toBeNull();
  });

  it('withholds a draft, so unfinished dates never reach delegates', async () => {
    const { service } = build(edition({ status: EditionStatus.DRAFT }));
    expect(await service.current()).toBeNull();
  });

  it('shows a draft to the console, which is where it is being written', async () => {
    const { service } = build(edition({ status: EditionStatus.DRAFT }));
    expect((await service.current(true))?.status).toBe(EditionStatus.DRAFT);
  });

  it('still returns an ended edition, so GS-26 stays readable', async () => {
    const { service } = build(edition({ status: EditionStatus.ENDED }));
    expect((await service.current())?.status).toBe(EditionStatus.ENDED);
  });
});

describe('EditionsService.create', () => {
  it('gives a new event every active track and interest unless it picks its own', async () => {
    const { service, catalog } = build();
    const base = {
      name: 'GS-27',
      shortName: 'GS-27',
      startsAt: '2027-09-07T08:00:00+01:00',
      endsAt: '2027-09-08T17:00:00+01:00',
    };
    await expect(service.create(base)).resolves.toMatchObject({
      trackValues: ['digital', 'health'],
      interestValues: ['Policy'],
    });
    await expect(
      service.create({ ...base, trackValues: ['health'], interestValues: [] }),
    ).resolves.toMatchObject({ trackValues: ['health'], interestValues: [] });
    expect(catalog.cleanTopics).toHaveBeenLastCalledWith({
      trackValues: ['health'],
      interestValues: [],
    });
  });

  it('stores dates as dates and trims the venue', async () => {
    const { service } = build();
    const created = await service.create({
      name: 'GS-27',
      shortName: 'GS-27',
      startsAt: '2027-09-07T08:00:00+01:00',
      endsAt: '2027-09-08T17:00:00+01:00',
      venue: '  Abuja  ',
    });

    expect(created.startsAt).toBeInstanceOf(Date);
    expect(created.venue).toBe('Abuja');
  });

  it('treats an empty venue as no venue rather than an empty string', async () => {
    const { service } = build();
    const created = await service.create({
      name: 'GS-27',
      shortName: 'GS-27',
      startsAt: '2027-09-07T08:00:00+01:00',
      endsAt: '2027-09-08T17:00:00+01:00',
      venue: '   ',
    });
    expect(created.venue).toBeNull();
  });

  it('refuses an edition that ends before it starts', async () => {
    const { service } = build();
    await expect(
      service.create({
        name: 'GS-27',
        shortName: 'GS-27',
        startsAt: '2027-09-08T17:00:00+01:00',
        endsAt: '2027-09-07T08:00:00+01:00',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a zero-length edition', async () => {
    const { service } = build();
    const sameMoment = '2027-09-07T08:00:00+01:00';
    await expect(
      service.create({
        name: 'GS-27',
        shortName: 'GS-27',
        startsAt: sameMoment,
        endsAt: sameMoment,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('EditionsService.update', () => {
  it('validates the row as it will be, not only what was sent', async () => {
    // Moving only the end date, to before the existing start date, has to be
    // caught: the request on its own looks harmless.
    const { service } = build();
    await expect(
      service.update('gs27', { endsAt: '2027-01-01T08:00:00+01:00' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('opens registration without touching anything else', async () => {
    const { service } = build();
    const updated = await service.update('gs27', { registrationOpen: true });

    expect(updated.registrationOpen).toBe(true);
    expect(updated.status).toBe(EditionStatus.ANNOUNCED);
    expect(updated.venue).toBe('Abuja, Nigeria');
  });

  it('leaves the venue alone when the field is not sent', async () => {
    const { service } = build();
    const updated = await service.update('gs27', {
      status: EditionStatus.LIVE,
    });
    expect(updated.venue).toBe('Abuja, Nigeria');
  });

  it('points the centre button at a different screen', async () => {
    const { service } = build();
    const updated = await service.update('gs27', {
      centreAction: CentreAction.INNOVATION,
    });
    expect(updated.centreAction).toBe(CentreAction.INNOVATION);
  });

  it('treats a cleared label as "use the default wording"', async () => {
    const { service } = build(edition({ centreLabel: 'My Pass' }));
    const updated = await service.update('gs27', { centreLabel: '  ' });
    expect(updated.centreLabel).toBeNull();
  });

  it('leaves the label alone when the field is not sent', async () => {
    const { service } = build(edition({ centreLabel: 'My Pass' }));
    const updated = await service.update('gs27', {
      centreAction: CentreAction.SCAN,
    });
    expect(updated.centreLabel).toBe('My Pass');
  });

  it('404s for an edition that does not exist', async () => {
    const { service } = build(null);
    await expect(service.update('nope', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('replaces the feature list in the order sent', async () => {
    const { service } = build();
    const updated = await service.update('gs27', {
      features: ['captions', 'schedule', 'polls'],
    });
    expect(updated.features).toEqual(['captions', 'schedule', 'polls']);
  });

  it('leaves features alone when the field is not sent', async () => {
    const { service } = build();
    const updated = await service.update('gs27', { registrationOpen: true });
    expect(updated.features).toEqual(DEFAULT_EDITION_FEATURES);
  });

  it('stores help info trimmed, without blank keys, as a plain object', async () => {
    const { service } = build();
    const updated = await service.update('gs27', {
      info: {
        wifi: { network: '  GS27-Delegates ', password: '   ' },
        helpDesk: { phone: '', email: ' Help@PICevents.NG ' },
        breaks: [
          {
            label: ' Lunch ',
            startsAt: '2027-09-07T13:00:00+01:00',
            endsAt: '2027-09-07T14:00:00+01:00',
            location: '',
          },
          {
            label: '   ',
            startsAt: '2027-09-07T16:00:00+01:00',
            endsAt: '2027-09-07T16:15:00+01:00',
          },
        ],
        prayerRoom: '',
        notes: [' Bring your ID ', '  '],
      },
    });
    expect(updated.info).toEqual({
      wifi: { network: 'GS27-Delegates' },
      helpDesk: { email: 'help@picevents.ng' },
      breaks: [
        {
          label: 'Lunch',
          startsAt: '2027-09-07T13:00:00+01:00',
          endsAt: '2027-09-07T14:00:00+01:00',
        },
      ],
      notes: ['Bring your ID'],
    });
  });

  it('clears help info with null, and with an object that says nothing', async () => {
    const filled = build(edition({ info: { prayerRoom: 'Room 2B' } }));
    expect(
      (await filled.service.update('gs27', { info: null })).info,
    ).toBeNull();

    const blank = build(edition({ info: { prayerRoom: 'Room 2B' } }));
    expect(
      (await blank.service.update('gs27', { info: { notes: ['  '] } })).info,
    ).toBeNull();
  });

  it('leaves help info alone when the field is not sent', async () => {
    const { service } = build(edition({ info: { prayerRoom: 'Room 2B' } }));
    const updated = await service.update('gs27', { city: 'Lagos' });
    expect(updated.info).toEqual({ prayerRoom: 'Room 2B' });
  });
});

describe('EditionsService.isMuted', () => {
  it('is false for everything by default', async () => {
    const { service } = build();
    expect(await service.isMuted('session-updated')).toBe(false);
  });

  it('is true for a kind the organiser switched off', async () => {
    const { service } = build(
      edition({ mutedNotifications: ['session-updated', 'session-reminder'] }),
    );
    expect(await service.isMuted('session-updated')).toBe(true);
    expect(await service.isMuted('session-live')).toBe(false);
  });

  it('honours a draft, which is the programme being reshuffled', async () => {
    const { service } = build(
      edition({
        status: EditionStatus.DRAFT,
        mutedNotifications: ['session-created'],
      }),
    );
    expect(await service.isMuted('session-created')).toBe(true);
  });

  it('mutes nothing when no edition exists, as before editions', async () => {
    const { service } = build(null);
    expect(await service.isMuted('session-live')).toBe(false);
  });
});

describe('EditionsService.setCurrent', () => {
  it('clears the others and sets this one, in one transaction', async () => {
    const { service, repo, dataSource } = build();
    const result = await service.setCurrent('gs27');

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    // the clear must exclude the row being set, or the unique index rejects it
    expect(repo.update).toHaveBeenCalledWith(
      expect.objectContaining({ isCurrent: true }),
      { isCurrent: false },
    );
    expect(result.isCurrent).toBe(true);
  });

  it('refuses to point the app at a draft', async () => {
    // Sessions are scoped to whatever is current, so making a draft current
    // would publish a half-built programme and next year's dates without a
    // word of warning.
    const { service, repo } = build(edition({ status: EditionStatus.DRAFT }));
    await expect(service.setCurrent('gs27')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('404s rather than leaving no edition current', async () => {
    const { service, repo } = build(null);
    await expect(service.setCurrent('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repo.update).not.toHaveBeenCalled();
  });
});

describe('EditionsService.browse price and dates', () => {
  const free = edition({
    id: 'free',
    startsAt: new Date('2027-09-07T08:00:00Z'),
  });
  const paid = edition({
    id: 'paid',
    startsAt: new Date('2027-09-30T15:00:00Z'),
  });
  const october = edition({
    id: 'october',
    startsAt: new Date('2027-10-01T08:00:00Z'),
    endsAt: new Date('2027-10-02T08:00:00Z'),
  });
  const ended = edition({
    id: 'ended',
    startsAt: new Date('2020-09-10T08:00:00Z'),
    endsAt: new Date('2020-09-11T08:00:00Z'),
    status: EditionStatus.ENDED,
  });

  it('keeps editions with an active priced tier for price=paid', async () => {
    const { service, repo, dataSource } = build();
    repo.find.mockResolvedValue([free, paid]);
    dataSource.query.mockResolvedValueOnce([{ editionId: 'paid' }]);
    const list = await service.browse({ price: 'paid' });
    expect(list.map((c) => c.id)).toEqual(['paid']);
    const [sql, params] = dataSource.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('"isActive" = true');
    expect(sql).toContain('price > 0');
    expect(params).toEqual([['free', 'paid']]);
  });

  it('keeps everything else for price=free, including editions with no tiers', async () => {
    const { service, repo, dataSource } = build();
    repo.find.mockResolvedValue([free, paid, october]);
    dataSource.query.mockResolvedValueOnce([{ editionId: 'paid' }]);
    const list = await service.browse({ price: 'free' });
    expect(list.map((c) => c.id)).toEqual(['free', 'october']);
  });

  it('asks nothing about prices when no price filter is given', async () => {
    const { service, repo, dataSource } = build();
    repo.find.mockResolvedValue([free]);
    await service.browse({});
    const sqls = (dataSource.query.mock.calls as [string][]).map((c) => c[0]);
    expect(sqls.some((s) => s.includes('ticket_types'))).toBe(false);
  });

  it('filters start dates inclusively, a bare "to" covering the whole day', async () => {
    const { service, repo } = build();
    repo.find.mockResolvedValue([free, paid, october]);
    const list = await service.browse({ from: '2027-09-07', to: '2027-09-30' });
    expect(list.map((c) => c.id)).toEqual(['free', 'paid']);
  });

  it('ignores `when` once a window is given, so past editions can be found by date', async () => {
    const { service, repo } = build();
    repo.find.mockResolvedValue([ended, free]);
    const list = await service.browse({
      when: 'upcoming',
      from: '2020-01-01',
      to: '2020-12-31',
    });
    expect(list.map((c) => c.id)).toEqual(['ended']);
  });

  it('takes an open-ended window from one side', async () => {
    const { service, repo } = build();
    repo.find.mockResolvedValue([ended, free, october]);
    expect(
      (await service.browse({ from: '2027-10-01T00:00:00Z' })).map((c) => c.id),
    ).toEqual(['october']);
    expect(
      (await service.browse({ to: '2027-09-07T08:00:00Z' })).map((c) => c.id),
    ).toEqual(['ended', 'free']);
  });

  it('refuses a window that ends before it starts', async () => {
    const { service } = build();
    await expect(
      service.browse({ from: '2027-10-01', to: '2027-09-01' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('EditionsService address and ticket terms', () => {
  const base = {
    name: 'GS-27',
    shortName: 'GS-27',
    startsAt: '2027-09-07T08:00:00+01:00',
    endsAt: '2027-09-08T17:00:00+01:00',
  };

  it('gives a new edition the standard ticket terms', async () => {
    const { service } = build();
    const created = await service.create(base);
    expect(created.ticketTerms).toEqual(DEFAULT_TICKET_TERMS);
    expect(created.ticketTerms).toHaveLength(5);
    expect(created.ticketTerms[0]).toBe(
      'Tickets are non-refundable unless the event is cancelled.',
    );
    // a copy, so editing one edition's terms cannot touch the default
    expect(created.ticketTerms).not.toBe(DEFAULT_TICKET_TERMS);
  });

  it('takes terms and an address on create, trimmed', async () => {
    const { service } = build();
    const created = await service.create({
      ...base,
      address: '  Plot 1, Ahmadu Bello Way ',
      ticketTerms: [' Bring ID. ', '  '],
    });
    expect(created.address).toBe('Plot 1, Ahmadu Bello Way');
    expect(created.ticketTerms).toEqual(['Bring ID.']);
  });

  it('replaces terms on update, and leaves them alone when not sent', async () => {
    const replaced = build(edition({ ticketTerms: ['Old'] }));
    expect(
      (await replaced.service.update('gs27', { ticketTerms: ['New'] }))
        .ticketTerms,
    ).toEqual(['New']);

    const kept = build(edition({ ticketTerms: ['Old'], address: 'Here' }));
    const b = await kept.service.update('gs27', { city: 'Lagos' });
    expect(b.ticketTerms).toEqual(['Old']);
    expect(b.address).toBe('Here');
  });

  it('clears the address with an empty string', async () => {
    const { service } = build(edition({ address: 'Here' }));
    expect((await service.update('gs27', { address: ' ' })).address).toBeNull();
  });

  it('carries address and ticket terms on every card', async () => {
    const { service } = build(
      edition({ address: 'Plot 1', ticketTerms: ['One per person.'] }),
    );
    const card = await service.card('gs27');
    expect(card.address).toBe('Plot 1');
    expect(card.ticketTerms).toEqual(['One per person.']);

    const bare = build();
    const plain = await bare.service.card('gs27');
    expect(plain.address).toBeNull();
    expect(plain.ticketTerms).toEqual([]);
  });
});

describe('EditionsService audience cache', () => {
  const countsFor = (dataSource: { query: jest.Mock }) =>
    (dataSource.query.mock.calls as [string][]).filter(([sql]) =>
      sql.includes('COUNT(*)::int AS count FROM ('),
    );

  it('misses, queries the database once, and caches each edition for 60 s', async () => {
    const { service, dataSource, pipeline, cache } = build();
    dataSource.query
      .mockResolvedValueOnce([{ editionId: 'gs27', count: 12 }])
      .mockResolvedValueOnce([
        { editionId: 'gs27', id: 'd1', name: 'Ada', avatarUrl: 'avatars/d1' },
      ]);
    const card = await service.card('gs27');
    expect(card.attendeeCount).toBe(12);
    expect(countsFor(dataSource)).toHaveLength(1);
    expect(pipeline.set).toHaveBeenCalledWith(
      'edition:audience:gs27',
      expect.any(String),
      'EX',
      60,
    );
    // the raw avatar key is cached, never a signed URL that would expire
    expect(JSON.parse(cache.get('edition:audience:gs27')!)).toEqual({
      count: 12,
      preview: [
        { editionId: 'gs27', id: 'd1', name: 'Ada', avatarUrl: 'avatars/d1' },
      ],
    });
  });

  it('serves a hit from Redis without touching the audience SQL, and still signs avatars', async () => {
    const { service, dataSource, cache, storage } = build();
    cache.set(
      'edition:audience:gs27',
      JSON.stringify({
        count: 7,
        preview: [
          { editionId: 'gs27', id: 'd1', name: 'Ada', avatarUrl: 'avatars/d1' },
        ],
      }),
    );
    storage.resolveAvatar.mockResolvedValue('https://signed/d1');
    const card = await service.card('gs27');
    expect(card.attendeeCount).toBe(7);
    expect(card.attendeePreview[0].avatarUrl).toBe('https://signed/d1');
    expect(countsFor(dataSource)).toHaveLength(0);
    // only the ratings query ran
    expect(dataSource.query).toHaveBeenCalledTimes(1);
  });

  it('queries only the editions the cache missed, and caches zero for a quiet one', async () => {
    const { service, repo, dataSource, cache } = build();
    repo.find.mockResolvedValue([
      edition({ id: 'hot' }),
      edition({ id: 'quiet' }),
    ]);
    cache.set(
      'edition:audience:hot',
      JSON.stringify({ count: 40, preview: [] }),
    );
    const cards = await service.cardsByIds(['hot', 'quiet']);
    expect(cards.get('hot')!.attendeeCount).toBe(40);
    expect(cards.get('quiet')!.attendeeCount).toBe(0);
    const [[, params]] = countsFor(dataSource) as unknown as [
      [string, unknown[]],
    ];
    expect(params).toEqual([['quiet']]);
    expect(JSON.parse(cache.get('edition:audience:quiet')!)).toEqual({
      count: 0,
      preview: [],
    });
  });

  it('still renders from the database when Redis is down', async () => {
    const { service, redis, dataSource } = build();
    redis.mget.mockRejectedValue(new Error('ECONNREFUSED'));
    redis.pipeline.mockImplementation(() => {
      throw new Error('ECONNREFUSED');
    });
    dataSource.query.mockResolvedValueOnce([{ editionId: 'gs27', count: 3 }]);
    const card = await service.card('gs27');
    expect(card.attendeeCount).toBe(3);
  });

  it('filters by edition inside every branch, before the UNION', async () => {
    const { service, dataSource } = build();
    await service.card('gs27');
    const [sql] = countsFor(dataSource)[0];
    // one edition filter per branch: bookmarks, attendance, tickets
    expect(sql.match(/"editionId" = ANY\(\$1\)/g)).toHaveLength(3);
    expect(sql).not.toMatch(
      /SELECT "delegateId", "sessionId" FROM session_bookmarks\s+UNION/,
    );
  });
});

describe('EditionsService.cardsByIds', () => {
  it('builds every card in one pass: one edition lookup, one audience and one ratings query', async () => {
    const { service, repo, dataSource } = build();
    repo.find.mockResolvedValue([edition({ id: 'a' }), edition({ id: 'b' })]);
    const cards = await service.cardsByIds(['a', 'b', 'a']);
    expect([...cards.keys()].sort()).toEqual(['a', 'b']);
    expect(repo.find).toHaveBeenCalledTimes(1);
    expect(repo.findOne).not.toHaveBeenCalled();
    // audience count + preview + ratings
    expect(dataSource.query).toHaveBeenCalledTimes(3);
  });

  it('404s when any id is a draft or missing, as card() does', async () => {
    const { service, repo } = build();
    repo.find.mockResolvedValue([
      edition({ id: 'a' }),
      edition({ id: 'b', status: EditionStatus.DRAFT }),
    ]);
    await expect(service.cardsByIds(['a', 'b'])).rejects.toBeInstanceOf(
      NotFoundException,
    );
    repo.find.mockResolvedValue([edition({ id: 'a' })]);
    await expect(service.cardsByIds(['a', 'gone'])).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('asks nothing for an empty list', async () => {
    const { service, repo } = build();
    expect((await service.cardsByIds([])).size).toBe(0);
    expect(repo.find).not.toHaveBeenCalled();
  });
});
