import { BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Queue } from 'bullmq';
import type { DataSource, Repository } from 'typeorm';
import type { CatalogService } from '../catalog/catalog.service';
import type { RealtimeService } from '../common/realtime/realtime.service';
import type { StorageService } from '../common/storage/storage.service';
import { DelegatesService } from './delegates.service';
import { SendDirectMessageDto } from './dto/send-direct-message.dto';
import { VOICE_NOTE_MAX_BYTES, VoiceNoteUploadDto } from './dto/voice-note.dto';
import type { Delegate } from './entities/delegate.entity';
import type { DirectMessage } from './entities/direct-message.entity';

/**
 * Voice notes in DMs: the upload is presigned into the sender's own folder
 * and bound to its size, and a message may only carry a key its sender
 * uploaded, once, recently, with the size and type storage actually holds.
 */
const ADA = '11111111-1111-4111-8111-111111111111';
const TUNDE = '22222222-2222-4222-8222-222222222222';
const CLIP = '33333333-3333-4333-8333-333333333333';
const adaKey = `dm-audio/${ADA}/${CLIP}`;

type Head = { size: number; contentType: string | null; lastModified: Date };

function build(
  opts: { head?: Head | null; used?: boolean; saveError?: unknown } = {},
) {
  const saved: Partial<DirectMessage>[] = [];
  const messages = {
    existsBy: jest.fn().mockResolvedValue(opts.used ?? false),
    create: jest.fn((v: Partial<DirectMessage>) => v),
    save: jest.fn((v: Partial<DirectMessage>) => {
      if (opts.saveError) return Promise.reject(opts.saveError);
      saved.push(v);
      return Promise.resolve({
        ...v,
        id: 'm1',
        createdAt: new Date('2026-09-26T10:00:00Z'),
      });
    }),
  };
  const delegates = {
    findOneBy: jest.fn().mockResolvedValue({ id: TUNDE }),
  };
  const blocks = { findOne: jest.fn().mockResolvedValue(null) };
  const head: Head | null =
    opts.head === undefined
      ? {
          size: 400_000,
          contentType: 'audio/mp4',
          lastModified: new Date(Date.now() - 5_000),
        }
      : opts.head;
  const storage = {
    presignUpload: jest.fn().mockResolvedValue({ uploadUrl: 'u', key: 'k' }),
    headObject: jest.fn().mockResolvedValue(head),
    deleteObject: jest.fn().mockResolvedValue(undefined),
    deletePrefix: jest.fn().mockResolvedValue(0),
    resolveStoredUrl: jest.fn((k: string) =>
      Promise.resolve(`https://signed/${k}`),
    ),
  };
  const realtime = { emitToRoom: jest.fn() };
  const tx = { query: jest.fn().mockResolvedValue([]) };
  const dataSource = {
    query: jest.fn(),
    transaction: jest.fn((fn: (t: typeof tx) => Promise<void>) => fn(tx)),
  };
  const service = new DelegatesService(
    delegates as unknown as Repository<Delegate>,
    {} as Repository<never>,
    {} as Repository<never>,
    messages as unknown as Repository<DirectMessage>,
    {} as Repository<never>,
    blocks as unknown as Repository<never>,
    realtime as unknown as RealtimeService,
    storage as unknown as StorageService,
    {} as Queue,
    dataSource as unknown as DataSource,
    {} as CatalogService,
  );
  return {
    service,
    storage,
    messages,
    realtime,
    saved,
    dataSource,
    delegates,
    tx,
  };
}

const voice = (over: Partial<{ key: string; contentType: string }> = {}) => ({
  audio: {
    key: adaKey,
    durationMs: 42_000,
    contentType: 'audio/mp4',
    ...over,
  },
});

describe('voice note upload', () => {
  it('presigns into the sender’s own folder, bound to the size', async () => {
    const { service, storage } = build();
    await service.presignVoiceNote(ADA, {
      contentType: 'audio/webm',
      size: 1234,
    });
    expect(storage.presignUpload).toHaveBeenCalledWith({
      folder: `dm-audio/${ADA}`,
      contentType: 'audio/webm',
      contentLength: 1234,
    });
  });

  it('refuses a size over the cap and a type that is not audio', async () => {
    const tooBig = await validate(
      plainToInstance(VoiceNoteUploadDto, {
        contentType: 'audio/mp4',
        size: VOICE_NOTE_MAX_BYTES + 1,
      }),
    );
    expect(tooBig.map((e) => e.property)).toEqual(['size']);
    const html = await validate(
      plainToInstance(VoiceNoteUploadDto, {
        contentType: 'text/html',
        size: 10,
      }),
    );
    expect(html.map((e) => e.property)).toEqual(['contentType']);
  });

  it('accepts a message with only a voice note, not one with nothing', async () => {
    const ok = await validate(plainToInstance(SendDirectMessageDto, voice()));
    expect(ok).toEqual([]);
    const badKey = await validate(
      plainToInstance(
        SendDirectMessageDto,
        voice({ key: 'delegate-avatars/x' }),
      ),
    );
    expect(badKey.map((e) => e.property)).toEqual(['audio']);

    const { service } = build();
    await expect(
      service.sendDirectMessage(ADA, TUNDE, { body: '  ' }),
    ).rejects.toThrow('Message body cannot be empty');
  });
});

describe('sending a voice note', () => {
  it('stores the key, returns a signed URL and pushes it over the socket', async () => {
    const { service, saved, realtime, storage } = build();
    const view = await service.sendDirectMessage(ADA, TUNDE, voice());

    expect(storage.headObject).toHaveBeenCalledWith(adaKey);
    expect(saved[0]).toMatchObject({
      body: '',
      audioKey: adaKey,
      audioDurationMs: 42_000,
      audioContentType: 'audio/mp4',
    });
    expect(view).toMatchObject({
      audioUrl: `https://signed/${adaKey}`,
      durationMs: 42_000,
    });
    // the storage key is not handed to clients
    expect(view).not.toHaveProperty('audioKey');
    expect(view).not.toHaveProperty('audioContentType');
    const [, event, payload] = realtime.emitToRoom.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ];
    expect(event).toBe('dm:new');
    expect(payload).toMatchObject({
      audioUrl: `https://signed/${adaKey}`,
      durationMs: 42_000,
    });
  });

  it('text messages come back with null audio', async () => {
    const { service } = build();
    const view = await service.sendDirectMessage(ADA, TUNDE, { body: 'hi' });
    expect(view).toMatchObject({
      body: 'hi',
      audioUrl: null,
      durationMs: null,
    });
  });

  it('refuses a key from someone else’s folder without asking storage', async () => {
    const { service, storage } = build();
    await expect(
      service.sendDirectMessage(
        ADA,
        TUNDE,
        voice({ key: `dm-audio/${TUNDE}/${CLIP}` }),
      ),
    ).rejects.toThrow('That voice note cannot be sent');
    expect(storage.headObject).not.toHaveBeenCalled();
  });

  it('refuses a key already attached to a message', async () => {
    const { service } = build({ used: true });
    await expect(
      service.sendDirectMessage(ADA, TUNDE, voice()),
    ).rejects.toThrow('already been sent');
  });

  it('turns a lost race on the unique key into the same refusal', async () => {
    const { service } = build({ saveError: { code: '23505' } });
    await expect(
      service.sendDirectMessage(ADA, TUNDE, voice()),
    ).rejects.toThrow('already been sent');
  });

  it('refuses a key with nothing uploaded behind it', async () => {
    const { service } = build({ head: null });
    await expect(
      service.sendDirectMessage(ADA, TUNDE, voice()),
    ).rejects.toThrow('did not finish uploading');
  });

  it('refuses and deletes an object over the size cap', async () => {
    const { service, storage } = build({
      head: {
        size: VOICE_NOTE_MAX_BYTES + 1,
        contentType: 'audio/mp4',
        lastModified: new Date(),
      },
    });
    await expect(
      service.sendDirectMessage(ADA, TUNDE, voice()),
    ).rejects.toThrow('too large');
    expect(storage.deleteObject).toHaveBeenCalledWith(adaKey);
  });

  it('refuses a stored type that differs from the claimed one', async () => {
    const { service } = build({
      head: {
        size: 10,
        contentType: 'audio/webm;codecs=opus',
        lastModified: new Date(),
      },
    });
    await expect(
      service.sendDirectMessage(ADA, TUNDE, voice()),
    ).rejects.toBeInstanceOf(BadRequestException);
    // parameters on the stored type are ignored
    const same = build({
      head: {
        size: 10,
        contentType: 'audio/webm;codecs=opus',
        lastModified: new Date(),
      },
    });
    await expect(
      same.service.sendDirectMessage(
        ADA,
        TUNDE,
        voice({ contentType: 'audio/webm' }),
      ),
    ).resolves.toMatchObject({ durationMs: 42_000 });
  });

  it('refuses an upload older than the send window', async () => {
    const { service } = build({
      head: {
        size: 10,
        contentType: 'audio/mp4',
        lastModified: new Date(
          Date.now() - DelegatesService.VOICE_NOTE_SEND_WINDOW_MS - 1000,
        ),
      },
    });
    await expect(
      service.sendDirectMessage(ADA, TUNDE, voice()),
    ).rejects.toThrow('expired');
  });
});

describe('deleting an account removes its voice notes', () => {
  it('deletes every voice note in its threads and its upload folder, after the rows', async () => {
    const { service, storage, dataSource, tx } = build();
    const hash = await bcrypt.hash('secret123', 4);
    (service as unknown as { delegateRepository: unknown }).delegateRepository =
      {
        createQueryBuilder: () => ({
          addSelect: function () {
            return this;
          },
          where: function () {
            return this;
          },
          getOne: () =>
            Promise.resolve({
              id: ADA,
              passwordHash: hash,
              accessTier: 'standard',
            }),
        }),
      };
    const theirs = `dm-audio/${TUNDE}/${CLIP}`;
    dataSource.query.mockResolvedValue([
      { audioKey: adaKey },
      { audioKey: theirs },
    ]);
    const order: string[] = [];
    tx.query.mockImplementation((sql: string) => {
      if (sql.startsWith('DELETE FROM delegates')) order.push('rows');
      return Promise.resolve([]);
    });
    storage.deleteObject.mockImplementation((k: string) => {
      order.push(k);
      return Promise.resolve();
    });

    await service.deleteAccount(ADA, 'secret123');

    expect(order).toEqual(['rows', adaKey, theirs]);
    expect(storage.deletePrefix).toHaveBeenCalledWith(`dm-audio/${ADA}/`);
  });
});
