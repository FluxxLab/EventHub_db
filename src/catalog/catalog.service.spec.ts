import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { StorageService } from '../common/storage/storage.service';
import type { Edition } from '../editions/entities/edition.entity';
import { EditionCategory } from '../editions/entities/edition.entity';
import { CatalogService, trackSlug } from './catalog.service';
import type { CategorySetting } from './entities/category-setting.entity';
import type { InterestOption } from './entities/interest-option.entity';
import type { TrackOption } from './entities/track-option.entity';

/**
 * The app renders these lists verbatim, so what matters is the shape, the
 * order, and that the version only moves when an admin changes something.
 */
const option = (over: Partial<InterestOption>): InterestOption =>
  ({
    id: over.value ?? 'x',
    value: 'x',
    label: over.value ?? 'x',
    sortOrder: 0,
    isActive: true,
    ...over,
  }) as InterestOption;

/** The GS-27 summit's five, as the EditionTopics migration seeds them. */
const SEEDED: [string, string, string][] = [
  [
    'digital',
    'Inclusive Digital Transformation',
    'Access, skills and platforms that leave no one out',
  ],
  ['economic', 'Economic Inclusion', 'Finance, enterprise and work'],
  ['gbv', 'Gender-Based Violence (GBV)', 'Prevention, response and justice'],
  ['health', 'Health & Nutrition', 'Maternal health, nutrition and care'],
  [
    'security',
    'Security & Transportation',
    'Safe movement and safe communities',
  ],
];
const seededTracks = (): TrackOption[] =>
  SEEDED.map(
    ([value, label, hint], sortOrder) =>
      ({
        id: value,
        value,
        label,
        hint,
        sortOrder,
        isActive: true,
      }) as TrackOption,
  );

type Row = { value: string; isActive: boolean };

/** Enough of a repository for these lists: find by isActive / In(values), exists by value. */
function fakeRepo<T extends Row>(rows: T[]) {
  const filter = (where?: { isActive?: boolean; value?: unknown }) => {
    let out = rows;
    if (where?.isActive) out = out.filter((r) => r.isActive);
    // In(values) arrives as a FindOperator carrying the list
    const values = (where?.value as { value?: string[] } | undefined)?.value;
    if (Array.isArray(values))
      out = out.filter((r) => values.includes(r.value));
    else if (typeof where?.value === 'string') {
      out = out.filter((r) => r.value === where.value);
    }
    return out;
  };
  return {
    rows,
    find: jest.fn(
      ({ where }: { where?: { isActive?: boolean; value?: unknown } } = {}) =>
        Promise.resolve(filter(where)),
    ),
    findOne: jest.fn().mockResolvedValue(null),
    exists: jest.fn(({ where }: { where: { value: string } }) =>
      Promise.resolve(filter(where).length > 0),
    ),
    create: jest.fn((v: Partial<T>) => v),
    save: jest.fn((v: T) => Promise.resolve(v)),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    query: jest.fn().mockResolvedValue([]),
  };
}

type EditionRow = Pick<
  Edition,
  'id' | 'shortName' | 'isCurrent' | 'trackValues' | 'interestValues'
>;

function build(
  interests: InterestOption[] = [],
  categories: Partial<CategorySetting>[] = [],
  { tracks = seededTracks(), editions = [] as EditionRow[] } = {},
) {
  const interestRepo = fakeRepo(interests);
  const trackRepo = fakeRepo(tracks);
  const editionRepo = {
    findOne: jest.fn(
      ({ where }: { where: { id?: string; isCurrent?: boolean } }) =>
        Promise.resolve(
          editions.find((e) =>
            where.isCurrent ? e.isCurrent : e.id === where.id,
          ) ?? null,
        ),
    ),
  };
  const categoryRepo = {
    find: jest.fn().mockResolvedValue(categories),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((v: Partial<CategorySetting>) => v),
    save: jest.fn((v: CategorySetting) => Promise.resolve(v)),
  };
  let signature = 0;
  const storage = {
    // a fresh signature per call, like the real presigner
    resolveStoredUrl: jest.fn((key: string | null) =>
      Promise.resolve(key ? `https://signed/${key}?sig=${++signature}` : null),
    ),
    presignUpload: jest.fn(({ folder }: { folder: string }) =>
      Promise.resolve({ uploadUrl: 'https://put', key: `${folder}/k` }),
    ),
  };
  const service = new CatalogService(
    interestRepo as unknown as Repository<InterestOption>,
    categoryRepo as unknown as Repository<CategorySetting>,
    trackRepo as unknown as Repository<TrackOption>,
    editionRepo as unknown as Repository<Edition>,
    storage as unknown as StorageService,
  );
  return { service, interestRepo, trackRepo, categoryRepo, storage };
}

describe('CatalogService.catalog', () => {
  it('returns every list in the documented shape', async () => {
    const { service } = build([
      option({ value: 'Policy', sortOrder: 0 }),
      option({ value: 'Health', sortOrder: 1 }),
    ]);
    const catalog = await service.catalog();

    expect(Object.keys(catalog).sort()).toEqual(
      [
        'version',
        'tracks',
        'interests',
        'interestMax',
        'genders',
        'reportReasons',
        'captionLanguages',
        'paymentCountries',
        'categories',
      ].sort(),
    );
    expect(catalog.version).toMatch(/^[0-9a-f]{40}$/);
    expect(catalog.interestMax).toBe(5);
    expect(catalog.interests).toEqual([
      { value: 'Policy', label: 'Policy' },
      { value: 'Health', label: 'Health' },
    ]);
    expect(catalog.tracks[0]).toEqual({
      value: 'digital',
      label: 'Inclusive Digital Transformation',
      hint: 'Access, skills and platforms that leave no one out',
    });
    expect(catalog.genders).toEqual([
      { value: 'female', label: 'Female' },
      { value: 'male', label: 'Male' },
      { value: 'non-binary', label: 'Non-binary' },
      { value: 'undisclosed', label: 'Prefer not to say' },
    ]);
    expect(catalog.reportReasons.map((r) => r.value)).toEqual([
      'harassment',
      'spam',
      'impersonation',
      'inappropriate',
      'other',
    ]);
    expect(catalog.reportReasons[3]).toEqual({
      value: 'inappropriate',
      label: 'Inappropriate content',
    });
  });

  it('lists the five theme tracks and leaves out the general bucket', async () => {
    const { service } = build();
    const { tracks } = await service.catalog();
    expect(tracks.map((t) => t.value)).toEqual([
      'digital',
      'economic',
      'gbv',
      'health',
      'security',
    ]);
    expect(tracks.every((t) => t.hint.length > 0)).toBe(true);
  });

  it('puts English first, then the enum order', async () => {
    const { service } = build();
    const { captionLanguages } = await service.catalog();
    expect(captionLanguages.map((l) => l.code)).toEqual([
      'en',
      'ha',
      'ig',
      'yo',
      'pcm',
      'fr',
    ]);
    expect(captionLanguages[0]).toEqual({ code: 'en', label: 'English' });
  });

  it('gives each payment country its dialling codes and aliases, Other last', async () => {
    const { service } = build();
    const { paymentCountries } = await service.catalog();
    expect(paymentCountries[0]).toEqual({
      code: 'NG',
      name: 'Nigeria',
      currency: 'NGN',
      dialCodes: ['+234'],
      aliases: ['nigeria'],
      localPatterns: ['^0[789][01]\\d{8}$'],
    });
    const gb = paymentCountries.find((c) => c.code === 'GB')!;
    expect(gb.aliases).toEqual(
      expect.arrayContaining(['united kingdom', 'uk']),
    );
    expect(paymentCountries.at(-1)).toEqual({
      code: 'XX',
      name: 'Other (pay in US dollars)',
      currency: 'USD',
      dialCodes: [],
      aliases: [],
      localPatterns: [],
    });
  });

  it('publishes local-number patterns the app can compile and match', async () => {
    const { service } = build();
    const { paymentCountries } = await service.catalog();
    const patterns = Object.fromEntries(
      paymentCountries.map((c) => [c.code, c.localPatterns]),
    );
    expect(patterns).toEqual({
      NG: ['^0[789][01]\\d{8}$'],
      GH: ['^0[235]\\d{8}$'],
      KE: ['^0[17]\\d{8}$'],
      ZA: ['^0[6-8]\\d{8}$'],
      US: [],
      GB: [],
      XX: [],
    });
    const matches = (code: string, local: string) =>
      patterns[code].some((p) => new RegExp(p).test(local.replace(/\s+/g, '')));
    expect(matches('NG', '0801 234 5678')).toBe(true);
    expect(matches('NG', '0601 234 5678')).toBe(false);
    expect(matches('GH', '024 123 4567')).toBe(true);
    expect(matches('KE', '0712 345 678')).toBe(true);
    expect(matches('ZA', '082 123 4567')).toBe(true);
    expect(matches('ZA', '0801234567890')).toBe(false);
  });

  it('returns every category, ordered by sortOrder, defaults filling missing rows', async () => {
    const { service } = build(
      [],
      [
        { slug: EditionCategory.COMMUNITY, label: 'Meetups', sortOrder: -1 },
        {
          slug: EditionCategory.TRAINING,
          label: 'Classes & Training',
          imageKey: 'category-images/t',
          sortOrder: 5,
        },
      ],
    );
    const { categories } = await service.catalog();
    expect(categories).toHaveLength(Object.values(EditionCategory).length);
    expect(categories[0]).toEqual({
      slug: 'community',
      label: 'Meetups',
      imageUrl: null,
      sortOrder: -1,
    });
    expect(categories[1]).toMatchObject({ slug: 'summits', label: 'Summits' });
    const training = categories.find(
      (c) => c.slug === EditionCategory.TRAINING,
    )!;
    expect(training.imageUrl).toMatch(/^https:\/\/signed\/category-images\/t/);
    // ties on sortOrder fall back to the enum order
    const slugs = categories.map((c) => c.slug);
    expect(slugs.indexOf(EditionCategory.EXHIBITIONS)).toBeGreaterThan(
      slugs.indexOf(EditionCategory.FELLOWSHIPS),
    );
  });

  it('only lists active interests', async () => {
    const { service } = build([
      option({ value: 'Policy' }),
      option({ value: 'Retired', isActive: false }),
    ]);
    const { interests } = await service.catalog();
    expect(interests.map((i) => i.value)).toEqual(['Policy']);
  });

  it('keeps the version stable across freshly signed image URLs, and moves it on an edit', async () => {
    const categories = [
      {
        slug: EditionCategory.SUMMITS,
        label: 'Summits',
        imageKey: 'category-images/s',
        sortOrder: 0,
      },
    ];
    const a = build([option({ value: 'Policy' })], categories);
    const first = await a.service.catalog();
    const second = await a.service.catalog();
    expect(first.categories[0].imageUrl).not.toBe(
      second.categories[0].imageUrl,
    );
    expect(second.version).toBe(first.version);

    const b = build(
      [option({ value: 'Policy', label: 'Public policy' })],
      [...categories],
    );
    expect((await b.service.catalog()).version).not.toBe(first.version);
  });
});

describe('CatalogService.assertInterests', () => {
  const options = [
    option({ value: 'Policy' }),
    option({ value: 'Health' }),
    option({ value: 'Retired', isActive: false }),
  ];

  it('accepts active options', async () => {
    const { service } = build(options);
    await expect(
      service.assertInterests(['Policy', 'Health'], []),
    ).resolves.toBeUndefined();
  });

  it('rejects an unknown interest by name', async () => {
    const { service } = build(options);
    const attempt = service.assertInterests(['Policy', 'Astrology'], []);
    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.assertInterests(['Policy', 'Astrology'], []),
    ).rejects.toThrow('Unknown interest: Astrology');
  });

  it('rejects a retired option the delegate does not already have', async () => {
    const { service } = build(options);
    await expect(service.assertInterests(['Retired'], [])).rejects.toThrow(
      'Unknown interest: Retired',
    );
  });

  it('keeps a retired or removed value the delegate already saved', async () => {
    const { service, interestRepo } = build(options);
    await expect(
      service.assertInterests(
        ['Retired', 'Gone', 'Policy'],
        ['Retired', 'Gone'],
      ),
    ).resolves.toBeUndefined();

    // nothing new at all: no query
    interestRepo.find.mockClear();
    await service.assertInterests(['Retired'], ['Retired']);
    expect(interestRepo.find).not.toHaveBeenCalled();
  });
});

describe('CatalogService admin', () => {
  it('refuses a duplicate interest value', async () => {
    const { service, interestRepo } = build();
    interestRepo.findOne.mockResolvedValue(option({ value: 'Policy' }));
    await expect(
      service.createInterest({ value: 'policy' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('adds an interest after the last one, labelled by its value', async () => {
    const { service } = build([option({ value: 'Youth', sortOrder: 11 })]);
    const created = await service.createInterest({ value: 'Sport' });
    expect(created).toMatchObject({
      value: 'Sport',
      label: 'Sport',
      sortOrder: 12,
      isActive: true,
    });
  });

  it('creates the category row on first edit and clears an image with null', async () => {
    const { service, categoryRepo } = build();
    const view = await service.updateCategory(EditionCategory.TRAINING, {
      imageKey: null,
    });
    expect(categoryRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'training',
        label: 'Classes & Training',
        imageKey: null,
        sortOrder: 5,
      }),
    );
    expect(view).toEqual({
      slug: 'training',
      label: 'Classes & Training',
      imageUrl: null,
      sortOrder: 5,
    });
  });

  it('presigns tile artwork into its own folder', async () => {
    const { service, storage } = build();
    const slip = await service.presignCategoryImage('image/jpeg');
    expect(storage.presignUpload).toHaveBeenCalledWith({
      folder: 'category-images',
      contentType: 'image/jpeg',
    });
    expect(slip.key).toBe('category-images/k');
  });
});

describe('CatalogService per-edition topics', () => {
  const gs27: EditionRow = {
    id: 'gs27',
    shortName: 'GS-27',
    isCurrent: true,
    trackValues: ['health', 'digital'],
    interestValues: ['Policy'],
  };

  it("gives the app the current edition's tracks and interests only", async () => {
    const { service } = build(
      [option({ value: 'Policy' }), option({ value: 'Health', sortOrder: 1 })],
      [],
      { editions: [gs27] },
    );
    const catalog = await service.catalog();
    // library order, not the order the edition stored them in
    expect(catalog.tracks.map((t) => t.value)).toEqual(['digital', 'health']);
    expect(catalog.interests.map((i) => i.value)).toEqual(['Policy']);
  });

  it("files sessions under the edition's tracks or the general bucket", async () => {
    const { service } = build([], [], { editions: [gs27] });
    await expect(service.sessionTracks('gs27')).resolves.toEqual([
      expect.objectContaining({ value: 'digital' }),
      expect.objectContaining({ value: 'health' }),
      expect.objectContaining({ value: 'general', label: 'General Programme' }),
    ]);
    await expect(
      service.assertSessionTrack('general', 'gs27'),
    ).resolves.toBeUndefined();
    await expect(
      service.assertSessionTrack('health', 'gs27'),
    ).resolves.toBeUndefined();
  });

  it('refuses a session track its edition does not use, by name', async () => {
    const { service, trackRepo } = build([], [], { editions: [gs27] });
    trackRepo.findOne.mockResolvedValue(seededTracks()[2]);
    await expect(service.assertSessionTrack('gbv', 'gs27')).rejects.toThrow(
      '"Gender-Based Violence (GBV)" is not one of GS-27\'s tracks. Add it to the event first, or file the session under General Programme.',
    );
  });

  it("checks an edition's picks against the libraries, keeping retired ones it had", async () => {
    const tracks = seededTracks();
    tracks[4].isActive = false; // security retired
    const { service } = build([option({ value: 'Policy' })], [], { tracks });
    await expect(
      service.cleanTopics({ trackValues: ['general', 'digital', 'digital'] }),
    ).resolves.toEqual({ trackValues: ['digital'] });
    await expect(
      service.cleanTopics({ trackValues: ['security'] }),
    ).rejects.toThrow(new BadRequestException('Unknown track: security'));
    await expect(
      service.cleanTopics(
        { trackValues: ['security'] },
        { trackValues: ['security'], interestValues: [] },
      ),
    ).resolves.toEqual({ trackValues: ['security'] });
    await expect(
      service.cleanTopics({ interestValues: ['Nope'] }),
    ).rejects.toThrow(new BadRequestException('Unknown interest: Nope'));
  });

  it('defaults a new edition to every active track and interest', async () => {
    const { service } = build([
      option({ value: 'Policy' }),
      option({ value: 'Old', isActive: false }),
    ]);
    await expect(service.defaultTopics()).resolves.toEqual({
      trackValues: ['digital', 'economic', 'gbv', 'health', 'security'],
      interestValues: ['Policy'],
    });
  });
});

describe('CatalogService track library', () => {
  it('makes a fixed value from the label', () => {
    expect(trackSlug('Climate & Environment')).toBe('climate-and-environment');
    expect(trackSlug('  Éducation / Youth  ')).toBe('education-youth');
    expect(trackSlug('!!!')).toBe('track');
    expect(trackSlug('x'.repeat(60))).toHaveLength(40);
  });

  it('adds a track after the last, with a value no other track has', async () => {
    const { service, trackRepo } = build([], [], {
      tracks: [
        ...seededTracks(),
        {
          id: 'c',
          value: 'climate',
          label: 'Climate (old)',
          hint: '',
          sortOrder: 9,
          isActive: false,
        } as TrackOption,
      ],
    });
    trackRepo.find.mockImplementationOnce(() =>
      Promise.resolve([{ sortOrder: 9 }] as TrackOption[]),
    );
    const created = await service.createTrack({ label: 'Climate' });
    expect(created).toMatchObject({
      value: 'climate-2',
      label: 'Climate',
      hint: '',
      sortOrder: 10,
    });
  });

  it('refuses a second track with the same name, or one called General Programme', async () => {
    const { service, trackRepo } = build();
    await expect(
      service.createTrack({ label: 'general programme' }),
    ).rejects.toBeInstanceOf(ConflictException);
    trackRepo.findOne.mockResolvedValue(seededTracks()[3]);
    await expect(
      service.createTrack({ label: 'health & nutrition' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('only deletes a track nothing is filed under, and takes it off events', async () => {
    const { service, trackRepo } = build();
    trackRepo.findOne.mockResolvedValue(seededTracks()[1]);
    trackRepo.query.mockResolvedValueOnce([{ '?column?': 1 }]);
    await expect(service.deleteTrack('economic')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(trackRepo.delete).not.toHaveBeenCalled();

    trackRepo.query.mockResolvedValue([]);
    await service.deleteTrack('economic');
    expect(trackRepo.delete).toHaveBeenCalledWith({ id: 'economic' });
    expect(trackRepo.query).toHaveBeenLastCalledWith(
      expect.stringContaining('array_remove("trackValues"'),
      ['economic'],
    );
  });
});
