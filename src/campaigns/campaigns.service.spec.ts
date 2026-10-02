import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { DataSource, Repository } from 'typeorm';
import type { StorageService } from '../common/storage/storage.service';
import type { EditionsService } from '../editions/editions.service';
import type { EmailSender } from '../notifications/email/email-sender.interface';
import { CampaignsService, type CampaignJob } from './campaigns.service';
import type { TrackingLinks } from './tracking-links';
import type { UnsubscribeLinks } from './unsubscribe-links';
import type { SaveCampaignDto } from './dto/campaign.dto';
import { CampaignRecipientRow } from './entities/campaign-recipient.entity';
import { EmailCampaign } from './entities/email-campaign.entity';

/**
 * Campaigns: drafts only can change, a typo'd merge field or half a button
 * is refused, sending snapshots the audience once and queues it, and an
 * empty audience is refused rather than "sent" to nobody.
 */
const EDITION = '22222222-2222-4222-8222-222222222222';

const draft = (over: Partial<EmailCampaign> = {}): EmailCampaign =>
  ({
    id: 'c1',
    editionId: EDITION,
    subject: 'Hello {{first_name}}',
    body: 'See you at {{event}}',
    buttonLabel: null,
    buttonUrl: null,
    audience: { kind: 'all', ticketTypeIds: [] },
    status: 'draft',
    recipients: 0,
    sent: 0,
    failed: 0,
    createdBy: 'staff',
    sentBy: null,
    queuedAt: null,
    finishedAt: null,
    ...over,
  }) as EmailCampaign;

function setup(
  opts: { row?: EmailCampaign; people?: object[]; noConsole?: boolean } = {},
) {
  const row = opts.row ?? draft();
  const inserted: unknown[] = [];
  const updated: unknown[] = [];
  const campaigns = {
    findOneBy: jest.fn().mockResolvedValue(row),
    find: jest.fn(),
    create: jest.fn((c: object) => c),
    save: jest.fn((c: object) => Promise.resolve(c)),
    delete: jest.fn(),
  } as unknown as Repository<EmailCampaign>;
  const manager = {
    findOne: jest.fn().mockResolvedValue(row),
    insert: jest.fn((_e: unknown, rows: unknown[]) => {
      inserted.push(...rows);
      return Promise.resolve();
    }),
    update: jest.fn((_e: unknown, _w: unknown, v: unknown) => {
      updated.push(v);
      return Promise.resolve();
    }),
  };
  const dataSource = {
    query: jest.fn().mockResolvedValue(opts.people ?? []),
    transaction: jest.fn((fn: (m: typeof manager) => unknown) => fn(manager)),
    getRepository: jest.fn().mockReturnValue({
      findOne: jest
        .fn()
        .mockResolvedValue({ name: 'Desk Staff', email: 'desk@pic.org' }),
    }),
  } as unknown as DataSource;
  const editions = {
    card: jest.fn().mockResolvedValue({ id: EDITION, name: 'GS-27 Summit' }),
    findById: jest.fn().mockResolvedValue({
      id: EDITION,
      name: 'GS-27 Summit',
      logoImage: null,
      coverImage: null,
      brandColor: null,
    }),
  } as unknown as EditionsService;
  const send = jest.fn().mockResolvedValue(undefined);
  const email: EmailSender = { send };
  const add = jest.fn().mockResolvedValue({});
  const queue = { add } as unknown as Queue<CampaignJob>;
  const links = {
    consoleUrl: jest
      .fn()
      .mockReturnValue(opts.noConsole ? null : 'https://console.pic.org'),
    pageUrl: jest.fn(
      (e: string) => `https://console.pic.org/unsubscribe?t=${e}`,
    ),
  } as unknown as UnsubscribeLinks;
  return {
    service: new CampaignsService(
      campaigns,
      dataSource,
      editions,
      email,
      queue,
      links,
      {
        enabled: jest.fn().mockReturnValue(true),
        apiUrl: jest.fn().mockReturnValue('https://api.pic.org/api/v1'),
      } as unknown as TrackingLinks,
      {
        resolveStoredUrl: jest.fn((k: string | null) =>
          Promise.resolve(k ? `https://signed/${k}` : null),
        ),
        presignRead: jest.fn((k: string) =>
          Promise.resolve(`https://signed/${k}`),
        ),
        presignUpload: jest.fn(),
      } as unknown as StorageService,
    ),
    dataSource,
    inserted,
    updated,
    add,
    send,
  };
}

const dto = (over: Partial<SaveCampaignDto> = {}): SaveCampaignDto => ({
  subject: 'Your badge',
  body: 'Hi {{first_name}}',
  audience: { kind: 'all', ticketTypeIds: [] },
  ...over,
});

describe('CampaignsService', () => {
  it('refuses merge fields that do not exist, and half a button', async () => {
    const { service } = setup();
    await expect(
      service.create(EDITION, 'staff', dto({ body: 'Hi {{firstname}}' })),
    ).rejects.toThrow('There is no {{firstname}} to fill in');
    await expect(
      service.create(EDITION, 'staff', dto({ buttonLabel: 'Open' })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('changes drafts only', async () => {
    const { service } = setup({ row: draft({ status: 'sent' }) });
    await expect(service.update('c1', dto())).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(service.remove('c1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('snapshots the audience and queues the first batch', async () => {
    const people = [
      { email: 'a@x.org', name: 'Ada', code: 'PIC-1', tier: 'VIP' },
      { email: 'b@x.org', name: 'Bola', code: 'PIC-2', tier: 'Standard' },
    ];
    const { service, inserted, updated, add } = setup({ people });
    await service.send('c1', 'staff');
    expect(inserted).toEqual(
      people.map((p) => ({ campaignId: 'c1', ...p, status: 'pending' })),
    );
    expect(updated[0]).toMatchObject({
      status: 'sending',
      recipients: 2,
      sentBy: 'staff',
      tracked: true,
    });
    expect(add).toHaveBeenCalledWith(
      'send-batch',
      { campaignId: 'c1', batch: 0 },
      expect.objectContaining({ jobId: 'campaign-c1-0' }),
    );
  });

  it('leaves out people who unsubscribed, and says how many', async () => {
    const { service } = setup({
      people: [
        {
          email: 'a@x.org',
          name: 'Ada',
          code: 'P1',
          tier: 'VIP',
          unsubscribed: false,
        },
        {
          email: 'b@x.org',
          name: 'Bola',
          code: 'P2',
          tier: 'VIP',
          unsubscribed: true,
        },
      ],
    });
    await expect(
      service.audienceSize(EDITION, { kind: 'all', ticketTypeIds: [] }),
    ).resolves.toEqual({ count: 1, unsubscribed: 1 });
    await expect(
      service.resolve(EDITION, { kind: 'all', ticketTypeIds: [] }),
    ).resolves.toEqual([
      { email: 'a@x.org', name: 'Ada', code: 'P1', tier: 'VIP' },
    ]);
  });

  it('refuses to send without the address the unsubscribe link needs', async () => {
    const { service, add } = setup({
      noConsole: true,
      people: [{ email: 'a@x.org' }],
    });
    await expect(service.send('c1', 'staff')).rejects.toThrow(
      'PUBLIC_CONSOLE_URL',
    );
    await expect(service.sendTest('c1', 'staff')).rejects.toThrow(
      'PUBLIC_CONSOLE_URL',
    );
    expect(add).not.toHaveBeenCalled();
  });

  it('refuses to send to nobody', async () => {
    const { service, add } = setup({ people: [] });
    await expect(service.send('c1', 'staff')).rejects.toThrow(
      'Nobody matches this audience yet',
    );
    expect(add).not.toHaveBeenCalled();
  });

  it('narrows the audience by tier and door status in the query', async () => {
    const { service, dataSource } = setup();
    await service.resolve(EDITION, {
      kind: 'not_checked_in',
      ticketTypeIds: ['t1'],
    });
    const [sql, params] = (dataSource.query as jest.Mock).mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(sql).toContain('ANY($2::uuid[])');
    expect(sql).toContain('HAVING NOT BOOL_OR(a.admitted)');
    expect(params).toEqual([EDITION, ['t1']]);
  });

  it('sends a test to the person asking, marked as a test', async () => {
    const { service, send } = setup();
    await expect(service.sendTest('c1', 'staff')).resolves.toEqual({
      to: 'desk@pic.org',
    });
    expect(send).toHaveBeenCalledWith(
      'desk@pic.org',
      '[Test] Hello Desk',
      expect.stringContaining('See you at GS-27 Summit'),
      expect.stringContaining('unsubscribe?t=desk@pic.org'),
    );
  });
});

// keep the entity import used (the recipient row type documents the insert)
void CampaignRecipientRow;
