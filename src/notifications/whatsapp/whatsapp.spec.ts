import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { MetaWhatsAppSender } from './meta-whatsapp.sender';
import { templateText, waNumber } from './whatsapp-sender.interface';
import { NotificationsProcessor } from '../notifications.processor';

/**
 * WhatsApp announcements: the Cloud API request, template-safe text, and the
 * rule that only delegates who opted in are messaged.
 */
const config = (values: Record<string, string>) =>
  ({
    get: (k: string) => values[k],
    getOrThrow: (k: string) => {
      if (!values[k]) throw new Error(`missing ${k}`);
      return values[k];
    },
  }) as unknown as ConfigService;

describe('MetaWhatsAppSender', () => {
  it('sends the approved template with the title and message as its parameters', async () => {
    const fetcher = jest.fn().mockResolvedValue({ ok: true });
    const sender = new MetaWhatsAppSender(
      config({ WHATSAPP_TOKEN: 't0k', WHATSAPP_PHONE_NUMBER_ID: '123' }),
      fetcher,
    );
    await sender.sendAnnouncement(
      '+2348012345678',
      'Hall B moved',
      'Now in\nHall C.',
    );
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/graph\.facebook\.com\/v\d+\.\d+\/123\/messages$/);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer t0k',
    );
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      messaging_product: 'whatsapp',
      to: '2348012345678',
      type: 'template',
      template: { name: 'pic_announcement', language: { code: 'en' } },
    });
    expect(
      body.template.components[0].parameters.map(
        (p: { text: string }) => p.text,
      ),
    ).toEqual(['Hall B moved', 'Now in Hall C.']);
  });

  it('throws when WhatsApp refuses, so the failure is counted', async () => {
    const fetcher = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('bad'),
    });
    const sender = new MetaWhatsAppSender(
      config({ WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '1' }),
      fetcher,
    );
    await expect(
      sender.sendAnnouncement('+2348000000000', 'a', 'b'),
    ).rejects.toThrow('400');
  });

  it('flattens text the way templates require', () => {
    expect(templateText('a\n\nb\tc      d', 100)).toBe('a b c   d');
    expect(templateText('x'.repeat(20), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(waNumber('+234 801 234 5678')).toBe('2348012345678');
  });
});

describe('WhatsApp copies of a broadcast', () => {
  function build(whatsapp: boolean) {
    const notifications = {
      findOneBy: jest.fn().mockResolvedValue({
        id: 'n1',
        title: 'T',
        body: 'B',
        segment: 'all',
        editionId: null,
        sentAt: null,
        whatsapp,
      }),
      update: jest.fn(),
    };
    const delegates = {
      idsForSegment: jest.fn().mockResolvedValue(['d1', 'd2', 'd3']),
      whatsappContacts: jest
        .fn()
        .mockResolvedValue([{ id: 'd2', phone: '+2348011111111' }]),
    };
    const queue = {
      getJob: jest.fn().mockResolvedValue(undefined),
      add: jest.fn().mockResolvedValue({}),
    };
    const sender = {
      live: true,
      sendAnnouncement: jest.fn().mockResolvedValue(undefined),
    };
    const processor = new NotificationsProcessor(
      { emitToRoom: jest.fn(), emitGlobal: jest.fn() } as never,
      delegates as never,
      notifications as never,
      { sendToTokens: jest.fn() },
      { find: jest.fn().mockResolvedValue([]), delete: jest.fn() } as never,
      queue as unknown as Queue,
      { add: jest.fn() } as never,
      sender,
    );
    return { processor, delegates, queue, sender };
  }
  const job = (name: string, data: unknown) => ({ name, data }) as never;

  it('queues WhatsApp only for delegates who opted in', async () => {
    const { processor, delegates, queue } = build(true);
    await processor.process(job('dispatch', { notificationId: 'n1' }));
    expect(delegates.whatsappContacts).toHaveBeenCalledWith(['d1', 'd2', 'd3']);
    expect(queue.add).toHaveBeenCalledWith(
      'whatsapp-chunk',
      {
        notificationId: 'n1',
        recipients: [{ id: 'd2', phone: '+2348011111111' }],
      },
      expect.objectContaining({ jobId: 'notif-wa-n1-0' }),
    );
  });

  it('leaves WhatsApp alone for an announcement not sent that way', async () => {
    const { processor, delegates, queue } = build(false);
    await processor.process(job('dispatch', { notificationId: 'n1' }));
    expect(delegates.whatsappContacts).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('keeps going past a number WhatsApp refuses', async () => {
    const { processor, sender } = build(true);
    sender.sendAnnouncement.mockRejectedValueOnce(new Error('not on WhatsApp'));
    await processor.process(
      job('whatsapp-chunk', {
        notificationId: 'n1',
        recipients: [
          { id: 'a', phone: '1' },
          { id: 'b', phone: '2' },
        ],
      }),
    );
    expect(sender.sendAnnouncement).toHaveBeenCalledTimes(2);
  });
});
