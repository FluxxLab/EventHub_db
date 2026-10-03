import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
  Logger,
  Optional,
} from '@nestjs/common';
import { TICKET_HOLDER_TAG } from '../ticketing/ticket-holders';
import { editionAudienceSql } from '../editions/edition-audience';
import { InjectRepository } from '@nestjs/typeorm';
import { AccessTier, Delegate, STAFF_TIERS } from './entities/delegate.entity';
import type { StaffRole } from './entities/set-admin.dto';
import { EditionAccessService } from '../common/edition-scope/edition-access.service';
import { DataSource, IsNull, Repository, In, Raw } from 'typeorm';
import * as bcrypt from 'bcrypt';

import { AudienceSegment } from '../notifications/entities/notification.entity';
import { RegistrationEntry } from './entities/registration-entry.entity';
import { randomBytes } from 'crypto';
import {
  CreateRegistrationEntryDto,
  UpdateRegistrationEntryDto,
} from './dto/create-delegate.dto';
import { UpdateMeDto } from './dto/update-me.dto';
import { CreateStaffDto } from './dto/create-staff.dto';
import { DelegateDirectoryDto } from './dto/delegate-directory.dto';
import { ListDirectoryDto } from './dto/list-directory.dto';
import { DelegateConnection } from './entities/delegate-connection.entity';
import { DirectMessage } from './entities/direct-message.entity';
import { MessageReaction } from './entities/message-reaction.entity';
import { DelegateBlock } from './entities/delegate-block.entity';
import { SendDirectMessageDto } from './dto/send-direct-message.dto';
import {
  type DirectMessageAudioDto,
  VOICE_NOTE_FOLDER,
  VOICE_NOTE_KEY,
  VOICE_NOTE_MAX_BYTES,
  type VoiceNoteUploadDto,
} from './dto/voice-note.dto';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { RealtimeService, Rooms } from '../common/realtime/realtime.service';
import { StorageService } from '../common/storage/storage.service';
import { CatalogService } from '../catalog/catalog.service';
import { PresenceService, type PresenceView } from './presence.service';

/** Who a delegate is, for reports that group by person rather than by content. */
export interface DelegateProfile {
  name: string;
  organisation: string | null;
  country: string | null;
  tracks: string[];
  interests: string[];
}

/** A tour id: short lowercase slug, as the app names them (`home`, `live-captions`). */
export const TOUR_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** More tours than the app will ever ship; the cap only stops abuse. */
export const MAX_TOURS_SEEN = 50;

/** Any UUID; presence ids are checked before they reach a ::uuid[] cast. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A DM as the API returns it: storage details swapped for a signed
 * `audioUrl` and `durationMs`, both null unless it is a voice note.
 */
export type DirectMessageView<T extends DirectMessage> = Omit<
  T,
  'audioKey' | 'audioDurationMs' | 'audioContentType'
> & { audioUrl: string | null; durationMs: number | null };

@Injectable()
export class DelegatesService {
  private readonly logger = new Logger(DelegatesService.name);

  constructor(
    @InjectRepository(Delegate)
    private readonly delegateRepository: Repository<Delegate>,
    @InjectRepository(RegistrationEntry)
    private readonly registrationRepository: Repository<RegistrationEntry>,
    @InjectRepository(DelegateConnection)
    private readonly connections: Repository<DelegateConnection>,
    @InjectRepository(DirectMessage)
    private readonly messages: Repository<DirectMessage>,
    @InjectRepository(MessageReaction)
    private readonly reactions: Repository<MessageReaction>,
    @InjectRepository(DelegateBlock)
    private readonly blocks: Repository<DelegateBlock>,
    private readonly realtime: RealtimeService,
    private readonly storage: StorageService,
    @InjectQueue('notifications')
    private readonly notificationsQueue: Queue,
    private readonly dataSource: DataSource,
    private readonly catalog: CatalogService,
    /** Forgets cached assignments when a role changes. Optional for the hand-built specs. */
    @Optional()
    private readonly editionAccess?: EditionAccessService,
    /** Online status; optional so the hand-built specs need not supply it. */
    @Optional()
    private readonly presence?: PresenceService,
  ) {}

  findByEmailForAuth(email: string): Promise<Delegate | null> {
    return this.delegateRepository
      .createQueryBuilder('delegate')
      .addSelect('delegate.passwordHash')
      .addSelect('delegate.googleSub')
      .where('delegate.email = :email', { email })
      .getOne();
  }

  /** Google sign-in: the account already linked to this Google id, if any. */
  findByGoogleSub(sub: string): Promise<Delegate | null> {
    return this.delegateRepository
      .createQueryBuilder('delegate')
      .addSelect('delegate.googleSub')
      .where('delegate.googleSub = :sub', { sub })
      .getOne();
  }

  /** Links a Google id to an account on its first Google sign-in. */
  async linkGoogle(id: string, sub: string): Promise<void> {
    await this.delegateRepository.update({ id }, { googleSub: sub });
  }

  /** The hash, for checking a password the signed-in delegate typed. */
  async passwordHashFor(id: string): Promise<string | null> {
    const d = await this.delegateRepository
      .createQueryBuilder('d')
      .addSelect('d.passwordHash')
      .where('d.id = :id', { id })
      .getOne();
    return d?.passwordHash ?? null;
  }

  /** Password reset and change. The hash arrives ready-made so bcrypt policy stays
   *  in one place (auth), and no other profile field can ride along. */
  async updatePassword(id: string, passwordHash: string): Promise<void> {
    // whoever sets it now knows it, so reset-password stays open to them
    await this.delegateRepository.update(
      { id },
      { passwordHash, hasChosenPassword: true },
    );
  }

  /**
   * Hands an unclaimed ticket-holder account (created when someone else paid
   * for their ticket) to the person who just proved the inbox at sign-up.
   * Their details and consent replace the placeholder; the tag comes off, so
   * they appear in the directory from now on. Their tickets are already here.
   */
  async claimHolderAccount(
    id: string,
    fields: {
      name: string;
      passwordHash: string;
      accessTier: AccessTier;
      phone: string | null;
      organisation: string | null;
      title: string | null;
      consentAt: Date;
      /** Google sign-in claims with a random password nobody knows. */
      hasChosenPassword?: boolean;
      googleSub?: string;
    },
  ): Promise<Delegate> {
    const delegate = await this.delegateRepository.findOneByOrFail({ id });
    Object.assign(delegate, fields, {
      hasChosenPassword: fields.hasChosenPassword ?? true,
      pendingReview: false,
      tags: (delegate.tags ?? []).filter((t) => t !== TICKET_HOLDER_TAG),
    });
    return this.delegateRepository.save(delegate);
  }

  findById(id: string): Promise<Delegate | null> {
    return this.delegateRepository.findOneBy({ id });
  }

  searchDelegates(q: string, limit: number): Promise<Delegate[]> {
    return (
      this.delegateRepository
        .createQueryBuilder('d')
        .where(
          '(d.name ILIKE :q OR d.organisation ILIKE :q OR d.country ILIKE :q)',
          { q: `%${q}%` },
        )
        // unclaimed ticket-holder accounts are not searchable (no consent yet)
        .andWhere('NOT (:holder = ANY(d.tags))', { holder: TICKET_HOLDER_TAG })
        // a delegate who hid themselves from the directory is hidden here too
        .andWhere('d.directoryVisible = true')
        .take(limit)
        .getMany()
    );
  }

  /** The segment's delegates; with an edition, only that edition's audience. */
  /** Of these delegates, the ones who opted in to WhatsApp and have a phone, with it. */
  async whatsappContacts(
    ids: string[],
  ): Promise<{ id: string; phone: string }[]> {
    if (!ids.length) return [];
    const rows = await this.delegateRepository
      .createQueryBuilder('d')
      .select(['d.id', 'd.phone'])
      .where('d.id IN (:...ids)', { ids })
      .andWhere('d.whatsappOptIn = true')
      .andWhere('d.phone IS NOT NULL')
      .orderBy('d.id', 'ASC')
      .getMany();
    return rows.map((d) => ({ id: d.id, phone: d.phone! }));
  }

  async idsForSegment(
    segment: string,
    editionId?: string | null,
    ticketTypeIds: string[] = [],
  ): Promise<string[]> {
    const qb = this.delegateRepository.createQueryBuilder('d').select(['d.id']);
    if (editionId && ticketTypeIds.length) {
      // only holders of those tiers' tickets, not everyone connected to the event
      qb.andWhere(
        `d.id IN (SELECT t."delegateId" FROM tickets t WHERE t."editionId" = :editionId AND t."ticketTypeId" IN (:...ticketTypeIds))`,
        { editionId, ticketTypeIds },
      );
    } else if (editionId) {
      qb.andWhere(
        `d.id IN (SELECT a."delegateId" FROM (${editionAudienceSql('= :editionId')}) a)`,
        { editionId },
      );
    }

    switch (segment) {
      case AudienceSegment.ALL:
        break;
      case AudienceSegment.VIP:
        qb.andWhere('d.accessTier IN (:...tiers)', {
          tiers: [AccessTier.VIP, AccessTier.VVIP],
        });
        break;
      case AudienceSegment.PRESS:
        qb.andWhere('d.accessTier = :tier', { tier: AccessTier.PRESS });
        break;
      case AudienceSegment.SPEAKERS:
        qb.andWhere(':tag = ANY(d.tags)', { tag: 'speaker' });
        break;
      case AudienceSegment.VOLUNTEERS:
        qb.andWhere(':tag = ANY(d.tags)', { tag: 'volunteer' });
        break;
    }
    return (await qb.getMany()).map((d) => d.id);
  }

  /**
   * Which segments this delegate belongs to - the inverse of idsForSegment,
   * and deliberately next to it so the two cannot drift. The notification
   * inbox uses this so that what a delegate can read back always matches what
   * they were actually sent.
   */
  async segmentsFor(delegateId: string): Promise<AudienceSegment[]> {
    const segments = [AudienceSegment.ALL];

    const delegate = await this.delegateRepository.findOne({
      where: { id: delegateId },
    });
    if (!delegate) return segments;

    if (
      delegate.accessTier === AccessTier.VIP ||
      delegate.accessTier === AccessTier.VVIP
    )
      segments.push(AudienceSegment.VIP);
    if (delegate.accessTier === AccessTier.PRESS)
      segments.push(AudienceSegment.PRESS);
    if (delegate.tags?.includes('speaker'))
      segments.push(AudienceSegment.SPEAKERS);
    if (delegate.tags?.includes('volunteer'))
      segments.push(AudienceSegment.VOLUNTEERS);

    return segments;
  }

  async segmentStats() {
    const [total, vip, vvip, flagged, press] = await Promise.all([
      this.delegateRepository.count(),
      this.delegateRepository.countBy({ accessTier: AccessTier.VIP }),
      this.delegateRepository.countBy({ accessTier: AccessTier.VVIP }),
      this.delegateRepository.countBy({ flagged: true }),
      this.delegateRepository.countBy({ accessTier: AccessTier.PRESS }),
    ]);
    return { total, vip, vvip, press, flagged };
  }

  /**
   * Unclaimed list entry matching code (priority) or email
   */
  async matchRegistration(
    email: string,
    inviteCode?: string,
  ): Promise<RegistrationEntry | null> {
    if (inviteCode) {
      return this.registrationRepository.findOneBy({
        inviteCode,
        claimedAt: IsNull(),
      });
    }
    return this.registrationRepository.findOneBy({
      email: email.toLocaleLowerCase(),
      claimedAt: IsNull(),
    });
  }

  async createDelegate(input: {
    name: string;
    email: string;
    passwordHash: string;
    accessTier: AccessTier;
    pendingReview: boolean;
    phone: string | null;
    organisation?: string | null;
    title?: string | null;
    consentAt: Date;
    hasChosenPassword?: boolean;
    googleSub?: string | null;
  }): Promise<Delegate> {
    return this.delegateRepository.save(this.delegateRepository.create(input));
  }

  async claimRegistration(entryId: string, delegateId: string): Promise<void> {
    await this.registrationRepository.update(
      { id: entryId, claimedAt: IsNull() },
      { claimedAt: new Date(), claimedByDelegateId: delegateId },
    );
  }

  async addRegistrationEntry(
    dto: CreateRegistrationEntryDto,
  ): Promise<RegistrationEntry> {
    return this.registrationRepository.save(
      this.registrationRepository.create({
        email: dto.email?.toLowerCase() ?? null,
        inviteCode:
          dto.inviteCode ?? randomBytes(4).toString('hex').toUpperCase(),
        name: dto.name ?? null,
        organisation: dto.organisation?.trim() || null,
        title: dto.title?.trim() || null,
        assignedTier: dto.assignedTier ?? AccessTier.STANDARD,
      }),
    );
  }

  listRegistrationEntries(): Promise<RegistrationEntry[]> {
    return this.registrationRepository.find();
  }

  async updateRegistrationEntry(
    id: string,
    dto: UpdateRegistrationEntryDto,
  ): Promise<RegistrationEntry> {
    const entry = await this.registrationRepository.findOneBy({ id });
    if (!entry) throw new NotFoundException('Registration entry not found');

    if (dto.email !== undefined) entry.email = dto.email?.toLowerCase() ?? null;
    if (dto.inviteCode !== undefined) entry.inviteCode = dto.inviteCode;
    if (dto.name !== undefined) entry.name = dto.name;
    if (dto.organisation !== undefined) {
      entry.organisation = dto.organisation.trim() || null;
    }
    if (dto.title !== undefined) entry.title = dto.title.trim() || null;
    if (dto.assignedTier !== undefined) entry.assignedTier = dto.assignedTier;

    return this.registrationRepository.save(entry);
  }

  async deleteRegistrationEntry(id: string): Promise<void> {
    const result = await this.registrationRepository.delete({ id });
    if (result.affected === 0) {
      throw new NotFoundException('Registration entry not found');
    }
  }

  async setTier(delegateId: string, tier: AccessTier): Promise<Delegate> {
    const delegate = await this.findById(delegateId);
    if (!delegate) throw new NotFoundException('Delegate not found');
    delegate.accessTier = tier;
    delegate.pendingReview = false;
    return this.delegateRepository.save(delegate);
  }

  /**
   * Approval gate. `pendingReview` is set at registration for anyone whose
   * email was not on the organisers' list; until an admin clears it the app
   * shows a waiting screen instead of the summit.
   *
   * The delegate's own room is notified so a phone sitting on that screen
   * lets them in without a restart.
   */
  async setApproval(id: string, approved: boolean): Promise<Delegate> {
    const delegate = await this.findById(id);
    if (!delegate) throw new NotFoundException('Delegate not found');
    // pendingReview is the inverse of approved, so this is "already in state"
    if (delegate.pendingReview === !approved) return delegate;

    delegate.pendingReview = !approved;
    const saved = await this.delegateRepository.save(delegate);
    this.realtime.emitToRoom(Rooms.network(id), 'delegate:approval', {
      approved,
    });
    return saved;
  }

  /**
   * Approve everyone still waiting, in one statement rather than a row at a
   * time - on the morning of the summit this is a queue of hundreds.
   */
  async approveAll(): Promise<{ approved: number }> {
    const pending = await this.delegateRepository.find({
      where: { pendingReview: true },
      select: { id: true },
    });
    if (pending.length === 0) return { approved: 0 };

    await this.delegateRepository.update(
      { pendingReview: true },
      { pendingReview: false },
    );
    for (const { id } of pending) {
      this.realtime.emitToRoom(Rooms.network(id), 'delegate:approval', {
        approved: true,
      });
    }
    return { approved: pending.length };
  }

  async getProfile(id: string): Promise<Delegate> {
    const d = await this.findById(id);
    if (!d) {
      throw new NotFoundException('Delegate not found');
    }
    return d;
  }

  async updateProfile(id: string, dto: UpdateMeDto) {
    const d = await this.getProfile(id);
    if (dto.tracks) {
      d.tracks = dto.tracks;
    }
    if (dto.interests) {
      // only managed options, but a retired one already saved stays put
      await this.catalog.assertInterests(dto.interests, d.interests ?? []);
      d.interests = dto.interests;
    }
    if (dto.avatarUrl !== undefined) {
      // stores the S3 key, not a URL - see StorageService.resolveAvatar
      d.avatarUrl = dto.avatarUrl;
    }
    if (dto.organisation !== undefined) {
      // an empty string clears it; the column is nullable and the directory shows nothing for null
      d.organisation = dto.organisation.trim() || null;
    }
    if (dto.title !== undefined) {
      d.title = dto.title.trim() || null;
    }
    // the DTO trims and length-checks it; null is not a name, so it is ignored
    if (typeof dto.name === 'string') {
      d.name = dto.name;
    }
    if (dto.phone !== undefined) {
      // normalised to E.164 by the DTO; an empty string clears it
      d.phone = dto.phone || null;
    }
    if (dto.gender !== undefined) {
      d.gender = dto.gender;
    }
    // going hidden withdraws everyone's view of your online status at once
    const hiding = dto.directoryVisible === false && d.directoryVisible;
    if (
      typeof dto.whatsappOptIn === 'boolean' &&
      dto.whatsappOptIn !== d.whatsappOptIn
    ) {
      if (dto.whatsappOptIn && !(dto.phone ?? d.phone)) {
        throw new BadRequestException(
          'Add your phone number first: WhatsApp updates go to it.',
        );
      }
      d.whatsappOptIn = dto.whatsappOptIn;
      d.whatsappOptInAt = dto.whatsappOptIn ? new Date() : null;
    }
    // no number, nowhere to send: clearing the phone ends the opt-in
    if (dto.phone === '' && d.whatsappOptIn) {
      d.whatsappOptIn = false;
      d.whatsappOptInAt = null;
    }
    if (typeof dto.directoryVisible === 'boolean') {
      d.directoryVisible = dto.directoryVisible;
    }
    if (dto.bio !== undefined) {
      // trimmed and length-checked by the DTO; an empty string clears it
      d.bio = dto.bio || null;
    }
    const saved = await this.delegateRepository.save(d);
    if (hiding) this.presence?.revokeAll(id);
    return this.withAvatar({ ...saved, avatarUrl: saved.avatarUrl ?? null });
  }

  /**
   * The current delegate, ready to render.
   *
   * Deliberately separate from getProfile: that one returns the entity that
   * updateProfile mutates and saves, so resolving the avatar there would write
   * a presigned URL back into the column and it would expire in the database.
   */
  async profileView(id: string) {
    const d = await this.getProfile(id);
    return this.withAvatar({ ...d, avatarUrl: d.avatarUrl ?? null });
  }

  /** Every delegate, or with an edition only its ticket holders. */
  async exportCsv(editionId?: string): Promise<string> {
    const rows = await this.delegateRepository.find({
      where: editionId
        ? {
            id: Raw(
              (alias) =>
                `${alias} IN (SELECT t."delegateId" FROM tickets t WHERE t."editionId" = :editionId)`,
              { editionId },
            ),
          }
        : {},
      order: { createdAt: 'ASC' },
    });
    const esc = (v: string | number | boolean | null | undefined) =>
      `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header =
      'name,email,organisation,tier,tracks,interests,consentAt,registeredAt';
    const lines = rows.map((d) =>
      [
        d.name,
        d.email,
        d.organisation,
        d.accessTier,
        d.tracks.join('; '),
        d.interests.join('; '),
        d.consentAt?.toISOString() ?? '',
        d.createdAt.toISOString(),
      ]
        .map(esc)
        .join(','),
    );
    return [header, ...lines].join('\n');
  }

  async namesByIds(
    ids: string[],
  ): Promise<
    Map<
      string,
      { name: string; organisation: string | null; avatarUrl: string | null }
    >
  > {
    if (ids.length === 0) {
      return new Map();
    }

    const rows = await this.delegateRepository.find({
      where: { id: In(ids) },
      select: { id: true, name: true, organisation: true, avatarUrl: true },
    });
    return new Map(
      rows.map((r) => [
        r.id,
        { name: r.name, organisation: r.organisation, avatarUrl: r.avatarUrl },
      ]),
    );
  }

  /**
   * namesByIds with the avatar resolved to a signed URL - what a client needs
   * to render an author line. namesByIds itself keeps the raw key because its
   * other callers (harvest reports) never render the photo.
   */
  async authorsByIds(
    ids: string[],
  ): Promise<
    Map<
      string,
      { name: string; organisation: string | null; avatarUrl: string | null }
    >
  > {
    const raw = await this.namesByIds(ids);
    const entries = await Promise.all(
      Array.from(raw.entries()).map(async ([id, a]) => {
        const avatarUrl = await this.storage.resolveAvatar(a.avatarUrl);
        return [id, { ...a, avatarUrl }] as const;
      }),
    );
    return new Map(entries);
  }

  /**
   * The onboarding segmentation, for reports that group by who said something
   * rather than what was said.
   *
   * Separate from namesByIds rather than folded into it: that one is on the
   * connections and moderation paths, where pulling two text arrays per row
   * would be paid on every request for data neither screen shows.
   */
  async profilesByIds(ids: string[]): Promise<Map<string, DelegateProfile>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) {
      return new Map();
    }

    const rows = await this.delegateRepository.find({
      where: { id: In(unique) },
      select: {
        id: true,
        name: true,
        organisation: true,
        country: true,
        tracks: true,
        interests: true,
      },
    });
    return new Map(
      rows.map((r) => [
        r.id,
        {
          name: r.name,
          organisation: r.organisation,
          country: r.country,
          tracks: r.tracks ?? [],
          interests: r.interests ?? [],
        },
      ]),
    );
  }

  async tagsFor(id: string): Promise<string[]> {
    const d = await this.delegateRepository.findOne({
      where: { id },
      select: { tags: true },
    });
    return d?.tags ?? [];
  }

  /**
   * The console's delegates list. Each row carries the person's tickets (with
   * an edition, that event's only), so the console shows and changes their
   * ticket tier rather than the old account tier.
   */
  async listDelegates(q: {
    search?: string;
    tier?: AccessTier;
    track?: string;
    editionId?: string;
    ticketTypeId?: string;
  }) {
    const qb = this.delegateRepository.createQueryBuilder('d');
    if (q.editionId) {
      qb.andWhere(
        `d.id IN (SELECT t."delegateId" FROM tickets t WHERE t."editionId" = :editionId${q.ticketTypeId ? ' AND t."ticketTypeId" = :ticketTypeId' : ''})`,
        { editionId: q.editionId, ticketTypeId: q.ticketTypeId },
      );
    }
    if (q.tier) qb.andWhere('d.accessTier = :tier', { tier: q.tier });
    if (q.search) {
      qb.andWhere(
        '(d.name ILIKE :s OR d.email ILIKE :s OR d.organisation ILIKE :s)',
        {
          s: `%${q.search}%`,
        },
      );
    }
    if (q.track) qb.andWhere(':track = ANY(d.tracks)', { track: q.track });
    const rows = await qb.orderBy('d.createdAt', 'DESC').take(500).getMany();
    if (rows.length === 0) return [];
    const tickets = await this.delegateRepository.query<
      {
        delegateId: string;
        ticketId: string;
        editionId: string;
        ticketTypeId: string;
        tierName: string;
      }[]
    >(
      `SELECT t."delegateId", t.id AS "ticketId", t."editionId", t."ticketTypeId", t."tierName"
       FROM tickets t
       WHERE t."delegateId" = ANY($1::uuid[])${q.editionId ? ' AND t."editionId" = $2' : ''}
       ORDER BY t."createdAt"`,
      q.editionId
        ? [rows.map((r) => r.id), q.editionId]
        : [rows.map((r) => r.id)],
    );
    const byPerson = new Map<
      string,
      Omit<(typeof tickets)[number], 'delegateId'>[]
    >();
    for (const { delegateId, ...t } of tickets) {
      byPerson.set(delegateId, [...(byPerson.get(delegateId) ?? []), t]);
    }
    return rows.map((r) => ({ ...r, tickets: byPerson.get(r.id) ?? [] }));
  }

  /**
   * Swaps a stored avatar key for a signed, time-limited URL.
   *
   * Kept separate from toDirectoryView because that mapper is static (`this:
   * void`) and signing needs the storage service. Signing is local HMAC, so
   * doing it per row costs no network round trip.
   */
  private async withAvatar<T extends { avatarUrl: string | null }>(
    view: T,
  ): Promise<T> {
    return {
      ...view,
      avatarUrl: await this.storage.resolveAvatar(view.avatarUrl),
    };
  }

  private withAvatars<T extends { avatarUrl: string | null }>(
    views: T[],
  ): Promise<T[]> {
    return Promise.all(views.map((v) => this.withAvatar(v)));
  }

  /**
   * Directory rows as the app renders them, avatars signed. Public so other
   * modules listing delegates (an edition's attendees) show them exactly as
   * the directory does, without a second copy of the signing.
   */
  directoryViews(rows: Delegate[]): Promise<DelegateDirectoryDto[]> {
    return this.withAvatars(rows.map(DelegatesService.toDirectoryView));
  }

  static toDirectoryView(this: void, d: Delegate): DelegateDirectoryDto {
    return {
      id: d.id,
      name: d.name,
      organisation: d.organisation ?? null,
      country: d.country ?? null,
      accessTier: d.accessTier,
      title: d.title ?? null,
      track: d.track ?? null,
      tags: d.tags ?? [],
      tracks: d.tracks ?? [],
      avatarUrl: d.avatarUrl ?? null,
    };
  }

  async listDelegatesPublic(
    query: ListDirectoryDto,
  ): Promise<{ items: DelegateDirectoryDto[]; total: number }> {
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    const q = query.q?.trim();

    // Delegates only: admin accounts are staff, not attendees, so they do not
    // belong in the networking list. Delegates awaiting review are included -
    // excluding them left the directory empty at an event where most delegates
    // self-register. Flagged accounts remain hidden.
    const qb = this.delegateRepository
      .createQueryBuilder('d')
      .where('d.flagged = :f', { f: false })
      // staff are not delegates to network with
      .andWhere('d.accessTier NOT IN (:...staff)', {
        staff: STAFF_TIERS,
      })
      // a ticket holder's account someone else's payment created: no consent
      // to be listed until they sign up and claim it
      .andWhere('NOT (:holder = ANY(d.tags))', { holder: TICKET_HOLDER_TAG })
      // hidden by their own choice (PATCH /delegates/me directoryVisible)
      .andWhere('d.directoryVisible = true');

    if (q) {
      qb.andWhere(
        '(d.name ILIKE :s OR d.organisation ILIKE :s OR d.country ILIKE :s)',
        { s: `%${q}%` },
      );
    }

    const [rows, total] = await qb
      .orderBy('d.name', 'ASC')
      .limit(limit)
      .offset(offset)
      .getManyAndCount();

    // resolve keys to signed URLs here too - the directory used to hand the raw
    // S3 key to the app, which rendered as a blank circle for every photo
    return {
      items: await this.directoryViews(rows),
      total,
    };
  }

  /**
   * The people at one edition: ticket holders plus anyone who saved or
   * attended one of its sessions (the same audience the card counts), under
   * the directory's rules. Flagged accounts, staff and unclaimed ticket-holder
   * accounts are left out as they are from the directory, and so is anyone
   * the caller has blocked or who has blocked the caller - a block that still
   * shows you the person in a list is not a block. The caller is included:
   * seeing yourself in the list is how you know you are registered.
   *
   * The caller is responsible for checking the edition is visible.
   */
  async listEditionAttendees(
    editionId: string,
    callerId: string,
    query: { q?: string; limit?: number; offset?: number },
  ): Promise<{ items: DelegateDirectoryDto[]; total: number }> {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const q = query.q?.trim();

    const qb = this.delegateRepository
      .createQueryBuilder('d')
      .where(
        `d.id IN (SELECT a."delegateId" FROM (${editionAudienceSql('= :editionId')}) a)`,
        { editionId },
      )
      .andWhere('d.flagged = :f', { f: false })
      .andWhere('d.accessTier NOT IN (:...staff)', {
        staff: STAFF_TIERS,
      })
      .andWhere('NOT (:holder = ANY(d.tags))', { holder: TICKET_HOLDER_TAG })
      // hidden by their own choice, except from themselves
      .andWhere('(d.directoryVisible = true OR d.id = :me)', { me: callerId })
      .andWhere(
        `NOT EXISTS (
          SELECT 1 FROM delegate_blocks b
          WHERE (b."blockerId" = :me AND b."blockedId" = d.id)
             OR (b."blockerId" = d.id AND b."blockedId" = :me)
        )`,
        { me: callerId },
      );

    if (q) {
      qb.andWhere(
        '(d.name ILIKE :s OR d.organisation ILIKE :s OR d.country ILIKE :s)',
        { s: `%${q}%` },
      );
    }

    const [rows, total] = await qb
      .orderBy('d.name', 'ASC')
      .limit(limit)
      .offset(offset)
      .getManyAndCount();

    return { items: await this.directoryViews(rows), total };
  }

  // Resolve one delegate for a scanned QR pass or a direct link. Unlike the
  // browsable directory this includes delegates awaiting review: they can already
  // send and receive DMs, so their identity has to render. Flagged delegates stay
  // hidden, and /connect still refuses both cases.
  //
  // The bio rides on this single-profile view only (bulk lists stay lean). A
  // delegate hidden from the directory shows no bio to anyone but themselves,
  // like their Attending list (delegateEditions).
  async findDirectoryEntry(
    id: string,
    viewerId?: string,
  ): Promise<DelegateDirectoryDto> {
    const delegate = await this.findById(id);
    if (!delegate || delegate.flagged) {
      throw new NotFoundException('Delegate not found');
    }
    const showBio = delegate.directoryVisible !== false || viewerId === id;
    return {
      ...(await this.withAvatar(DelegatesService.toDirectoryView(delegate))),
      pendingReview: delegate.pendingReview,
      bio: showBio ? (delegate.bio ?? null) : null,
    };
  }

  /**
   * The ids among `ids` whose online status `viewerId` may see: themselves,
   * or someone listed in the directory (not hidden, not flagged) with no
   * block between the two in either direction. One query for the batch.
   */
  async presenceVisibleIds(viewerId: string, ids: string[]): Promise<string[]> {
    const unique = [...new Set(ids)].filter((id) => UUID.test(id));
    if (unique.length === 0) return [];
    const rows: { id: string }[] = await this.delegateRepository.query(
      `SELECT d.id FROM delegates d
        WHERE d.id = ANY($2::uuid[])
          AND (d.id = $1 OR (
            d."directoryVisible" = true AND d.flagged = false
            AND NOT EXISTS (
              SELECT 1 FROM delegate_blocks b
               WHERE (b."blockerId" = $1 AND b."blockedId" = d.id)
                  OR (b."blockerId" = d.id AND b."blockedId" = $1)
            )
          ))`,
      [viewerId, unique],
    );
    return rows.map((r) => r.id);
  }

  /**
   * Online status for each id as `viewerId` may see it, in the order asked.
   * Anyone the viewer may not see reads as offline and never seen, the same
   * as someone who has never opened the app, so the answer leaks nothing.
   */
  async presenceFor(viewerId: string, ids: string[]): Promise<PresenceView[]> {
    const allowed = await this.presenceVisibleIds(viewerId, ids);
    const views: PresenceView[] = this.presence
      ? await this.presence.lookup(allowed)
      : [];
    const known = new Map(views.map((p) => [p.id, p]));
    return ids.map(
      (id) => known.get(id) ?? { id, online: false, lastSeenAt: null },
    );
  }

  listAdmins(): Promise<Delegate[]> {
    // both kinds of staff, so the Team page can show and revoke either
    return this.delegateRepository.find({
      where: { accessTier: In(STAFF_TIERS) },
      order: { accessTier: 'ASC', name: 'ASC' },
    });
  }

  /**
   * A staff login, created straight into its role. Approved from the start
   * (the approval gate is for self-registered delegates), consent stamped
   * now because an admin is creating it on the person's behalf, and the
   * password hashed with the same cost as registration so it is no weaker.
   */
  async createStaff(dto: CreateStaffDto): Promise<Delegate> {
    const email = dto.email.trim().toLowerCase();
    const managedEditionIds = await this.managedEditions(
      dto.role,
      dto.editionIds,
    );
    if (await this.findByEmailForAuth(email)) {
      throw new ConflictException('An account with this email already exists');
    }
    const created = await this.createDelegate({
      name: dto.name.trim(),
      email,
      passwordHash: await bcrypt.hash(dto.password, 12),
      accessTier: dto.role,
      pendingReview: false,
      phone: null,
      consentAt: new Date(),
    });
    if (managedEditionIds.length) {
      await this.delegateRepository.update(created.id, { managedEditionIds });
      created.managedEditionIds = managedEditionIds;
    }
    // never hand the hash back, even to an admin
    const { passwordHash: _hash, ...safe } = created;
    void _hash;
    return safe as Delegate;
  }

  async setAdmin(
    id: string,
    grant: boolean,
    actingUserId: string,
    role: StaffRole = AccessTier.ADMIN,
    editionIds?: string[],
  ): Promise<Delegate> {
    const delegate = await this.delegateRepository.findOneBy({ id });
    if (!delegate) throw new NotFoundException('Delegate not found');
    const managedEditionIds = grant
      ? await this.managedEditions(role, editionIds)
      : [];

    // The lock-out guards protect full admins only: a session admin cannot
    // run the console, so losing the last one loses nothing.
    if (!grant && delegate.accessTier === AccessTier.ADMIN) {
      // Guard 1: locking yourself out with one click
      if (id === actingUserId) {
        throw new BadRequestException(
          'You cannot revoke your own admin access',
        );
      }
      // Guard 2: locking EVERYONE out — unrecoverable without database access
      const admins = await this.delegateRepository.countBy({
        accessTier: AccessTier.ADMIN,
      });
      if (admins <= 1) {
        throw new BadRequestException('Cannot revoke the last remaining admin');
      }
    }

    // demoting the last full admin to an event organiser is a lock-out too
    if (
      grant &&
      role !== AccessTier.ADMIN &&
      delegate.accessTier === AccessTier.ADMIN
    ) {
      if (id === actingUserId) {
        throw new BadRequestException('You cannot change your own role');
      }
      const admins = await this.delegateRepository.countBy({
        accessTier: AccessTier.ADMIN,
      });
      if (admins <= 1) {
        throw new BadRequestException('Cannot change the last remaining admin');
      }
    }

    delegate.accessTier = grant ? role : AccessTier.STANDARD;
    delegate.managedEditionIds = managedEditionIds;
    const saved = await this.delegateRepository.save(delegate);
    this.editionAccess?.forget(id);
    return saved;
  }

  /**
   * An event organiser's editions: at least one, each one real. Other roles
   * carry none, so a later change of role cannot leave a stale assignment.
   */
  private async managedEditions(
    role: StaffRole,
    editionIds: string[] | undefined,
  ): Promise<string[]> {
    if (role !== AccessTier.EVENT_ADMIN) return [];
    const ids = [...new Set(editionIds ?? [])];
    if (ids.length === 0) {
      throw new BadRequestException(
        'Choose at least one event for an event organiser',
      );
    }
    const found = await this.delegateRepository.query(
      `SELECT id FROM editions WHERE id = ANY($1)`,
      [ids],
    );
    if (found.length !== ids.length) {
      throw new BadRequestException('One of the chosen events does not exist');
    }
    return ids;
  }

  static pairKey(a: string, b: string): string {
    return [a, b].sort().join(':');
  }

  async addConnection(
    fromId: string,
    toId: string,
  ): Promise<DelegateConnection> {
    if (fromId === toId) {
      throw new BadRequestException('You cannot connect to yourself');
    }
    const target = await this.findById(toId);
    if (!target) {
      throw new NotFoundException('Target delegate not found');
    }
    // Pending-review delegates are visible in the directory, so connecting to
    // them has to work too; only flagged accounts are refused.
    if (target.flagged) {
      throw new BadRequestException('Cannot connect: delegate is flagged');
    }
    // Same wording whichever side blocked, so neither party learns which
    if (await this.blockedEitherWay(fromId, toId)) {
      throw new ForbiddenException('You cannot connect with this delegate');
    }

    const pairKey = DelegatesService.pairKey(fromId, toId);
    const [aId, bId] = pairKey.split(':');
    const existing = await this.connections.findOneBy({
      fromDelegateId: aId,
      toDelegateId: bId,
    });

    const actor = await this.findById(fromId);
    const actorName = actor?.name ?? 'A delegate';

    if (existing) {
      existing.mutual = true;
      await this.connections.save(existing);
      this.realtime.emitToRoom(Rooms.network(toId), 'network:updated', {
        type: 'mutual',
        connectionId: existing.id,
      });
      // The other side had already added them; this closes the loop, and is
      // the more welcome of the two to hear about.
      await this.notifyConnection(
        toId,
        'You are now connected',
        `${actorName} connected back with you.`,
      );
      return existing;
    }

    const conn = await this.connections.save(
      this.connections.create({
        fromDelegateId: fromId,
        toDelegateId: toId,
        mutual: false,
      }),
    );
    this.realtime.emitToRoom(Rooms.network(toId), 'network:updated', {
      type: 'new-follower',
      connectionId: conn.id,
      fromDelegateId: fromId,
    });
    await this.notifyConnection(
      toId,
      'New connection',
      `${actorName} added you to their network.`,
    );
    return conn;
  }

  /**
   * Queued, never awaited into the caller's result: a delegate scanning a QR
   * pass is waiting on this request, and a slow FCM call or a Redis blip must
   * not fail a connection that has already been written.
   *
   * On the queue rather than through NotificationsService because that service
   * already depends on this one - calling back the other way would make it a
   * cycle for the sake of one message.
   */
  private async notifyConnection(
    delegateId: string,
    title: string,
    body: string,
  ): Promise<void> {
    try {
      await this.notificationsQueue.add('direct', {
        delegateId,
        title,
        body,
        category: 'network',
      });
    } catch (error) {
      this.logger.warn(
        `could not queue connection notification for ${delegateId}: ${(error as Error).message}`,
      );
    }
  }

  async listConnections(delegateId: string): Promise<
    Array<{
      delegate: DelegateDirectoryDto;
      mutual: boolean;
      since: Date;
      direction: 'outgoing' | 'incoming';
    }>
  > {
    const conns = await this.connections
      .createQueryBuilder('c')
      .where('c.fromDelegateId = :id OR c.toDelegateId = :id', {
        id: delegateId,
      })
      .getMany();

    const otherIds: string[] = [];
    for (const c of conns) {
      otherIds.push(
        c.fromDelegateId === delegateId ? c.toDelegateId : c.fromDelegateId,
      );
    }
    const uniqueIds = Array.from(new Set(otherIds));
    if (uniqueIds.length === 0) return [];
    const others = await this.namesByIds(uniqueIds);

    const items = conns
      .map((c) => {
        const otherId =
          c.fromDelegateId === delegateId ? c.toDelegateId : c.fromDelegateId;
        const other = others.get(otherId);
        if (!other) return null;
        return {
          delegate: {
            id: otherId,
            name: other.name,
            organisation: other.organisation,
            country: null,
            accessTier: AccessTier.STANDARD,
            title: null,
            track: null,
            tags: [],
            tracks: [],
            avatarUrl: other.avatarUrl,
          },
          mutual: c.mutual,
          /** When the connection was made. */
          since: c.createdAt,
          /** `outgoing`: the caller connected; `incoming`: they did (the caller can connect back). */
          direction:
            c.fromDelegateId === delegateId
              ? ('outgoing' as const)
              : ('incoming' as const),
        };
      })
      .filter(Boolean) as Array<{
      delegate: DelegateDirectoryDto;
      mutual: boolean;
      since: Date;
      direction: 'outgoing' | 'incoming';
    }>;

    const delegates = await this.withAvatars(items.map((i) => i.delegate));
    return items.map((i, idx) => ({ ...i, delegate: delegates[idx] }));
  }

  /**
   * Take a delegate out of your network.
   *
   * The pair goes, not one direction of it: a connection is shown to both
   * sides as "in your network", so leaving half a row behind would have them
   * still seeing you after you removed them. Rows are matched both ways
   * round because addConnection writes them in caller order.
   *
   * The other party's screen is refreshed over the socket but nobody is
   * notified - being dropped from a network is not news anyone wants pushed.
   */
  async removeConnection(callerId: string, otherId: string): Promise<void> {
    if (callerId === otherId) {
      throw new BadRequestException('You cannot remove yourself');
    }
    const result = await this.connections
      .createQueryBuilder()
      .delete()
      .where(
        '(fromDelegateId = :a AND toDelegateId = :b) OR (fromDelegateId = :b AND toDelegateId = :a)',
        { a: callerId, b: otherId },
      )
      .execute();
    if (!result.affected) {
      throw new NotFoundException('This delegate is not in your network');
    }
    this.realtime.emitToRoom(Rooms.network(otherId), 'network:updated', {
      type: 'removed',
      fromDelegateId: callerId,
    });
  }

  async countConnections(delegateId: string): Promise<number> {
    const rows = await this.connections
      .createQueryBuilder('c')
      .where('c.fromDelegateId = :id OR c.toDelegateId = :id', {
        id: delegateId,
      })
      .getCount();
    return rows;
  }

  async sendDirectMessage(
    senderId: string,
    recipientId: string,
    dto: SendDirectMessageDto,
  ): Promise<DirectMessageView<DirectMessage>> {
    if (senderId === recipientId) {
      throw new BadRequestException('You cannot DM yourself');
    }
    const recipient = await this.findById(recipientId);
    if (!recipient) {
      throw new NotFoundException('Recipient delegate not found');
    }
    const body = (dto.body ?? '').trim();
    if (!body && !dto.audio) {
      throw new BadRequestException('Message body cannot be empty');
    }
    // Refused in both directions with identical wording: a block that still
    // let the blocked person read replies would not be a block, and the
    // message must not reveal which side did the blocking.
    if (await this.blockedEitherWay(senderId, recipientId)) {
      throw new ForbiddenException('You cannot message this delegate');
    }

    const pairKey = DelegatesService.pairKey(senderId, recipientId);

    /**
     * A reply may only quote a message from this same thread. Without this
     * check a caller could pass any message id and have its text rendered
     * inside a conversation it does not belong to - which leaks the contents of
     * other people's DMs into a thread they can read.
     */
    if (dto.replyToId) {
      const parent = await this.messages.findOneBy({ id: dto.replyToId });
      if (!parent || parent.pairKey !== pairKey) {
        throw new BadRequestException('Cannot reply to that message');
      }
    }

    const audio = dto.audio
      ? await this.checkVoiceNote(senderId, dto.audio)
      : null;

    let msg: DirectMessage;
    try {
      msg = await this.messages.save(
        this.messages.create({
          pairKey,
          senderId,
          recipientId,
          body,
          readAt: null,
          replyToId: dto.replyToId ?? null,
          audioKey: audio?.key ?? null,
          audioDurationMs: audio?.durationMs ?? null,
          audioContentType: audio?.contentType ?? null,
        }),
      );
    } catch (error) {
      // uq_dm_audio_key: the same upload sent twice at once; the other won
      if (audio && (error as { code?: string }).code === '23505') {
        throw new BadRequestException('That voice note has already been sent');
      }
      throw error;
    }
    const view = await this.messageView(msg);

    // Deliver to the open thread and to the recipient's personal room, so a
    // delegate who is elsewhere in the app still receives the message.
    this.realtime.emitToRoom(
      [
        Rooms.dm(DelegatesService.pairKey(senderId, recipientId)),
        Rooms.network(recipientId),
      ],
      'dm:new',
      {
        id: msg.id,
        senderId,
        recipientId,
        body,
        createdAt: msg.createdAt,
        replyToId: msg.replyToId,
        audioUrl: view.audioUrl,
        durationMs: view.durationMs,
      },
    );

    this.logger.log(
      `DM sent ${senderId.slice(0, 8)}… → ${recipientId.slice(0, 8)}… (len=${body.length}${audio ? `, voice ${audio.durationMs}ms` : ''})`,
    );
    return view;
  }

  /**
   * A signed URL for a voice note: the sender PUTs the recording straight to
   * storage, under their own folder, then sends the key with the message.
   * The URL is bound to the declared size and type, so nothing larger than
   * VOICE_NOTE_MAX_BYTES can be stored there.
   */
  presignVoiceNote(senderId: string, dto: VoiceNoteUploadDto) {
    return this.storage.presignUpload({
      folder: `${VOICE_NOTE_FOLDER}/${senderId}`,
      contentType: dto.contentType,
      contentLength: dto.size,
    });
  }

  /** How long after uploading a voice note it may still be sent (the app sends at once). */
  static readonly VOICE_NOTE_SEND_WINDOW_MS = 60 * 60 * 1000;

  /**
   * A voice note may only be attached by the person who uploaded it, once,
   * soon after uploading, and only if storage holds what the message claims.
   * The key names its uploader (`dm-audio/<senderId>/<uuid>`, issued by
   * presignVoiceNote), so a key from someone else's folder - another
   * delegate's voice note, an avatar, a document - is refused before
   * storage is asked anything: a message can never be made to point at an
   * object its sender did not put there.
   */
  private async checkVoiceNote(
    senderId: string,
    audio: DirectMessageAudioDto,
  ): Promise<DirectMessageAudioDto> {
    const owner = VOICE_NOTE_KEY.exec(audio.key)?.[1];
    if (!owner || owner.toLowerCase() !== senderId.toLowerCase()) {
      throw new BadRequestException('That voice note cannot be sent');
    }
    if (await this.messages.existsBy({ audioKey: audio.key })) {
      throw new BadRequestException('That voice note has already been sent');
    }
    const stored = await this.storage.headObject(audio.key);
    if (!stored) {
      throw new BadRequestException(
        'The voice note did not finish uploading. Record it again.',
      );
    }
    if (stored.size === 0 || stored.size > VOICE_NOTE_MAX_BYTES) {
      await this.storage.deleteObject(audio.key);
      throw new BadRequestException('That voice note is too large');
    }
    const storedType = stored.contentType?.split(';')[0].trim().toLowerCase();
    if (storedType && storedType !== audio.contentType) {
      throw new BadRequestException('The voice note does not match its upload');
    }
    if (
      stored.lastModified &&
      Date.now() - stored.lastModified.getTime() >
        DelegatesService.VOICE_NOTE_SEND_WINDOW_MS
    ) {
      throw new BadRequestException(
        'That voice note has expired. Record it again.',
      );
    }
    return audio;
  }

  /**
   * A message as the app sees it: the voice note's storage key and type are
   * replaced by a freshly signed `audioUrl` and its `durationMs` (both null
   * for text). The bucket is private, so the key alone is useless to a
   * client and is not handed out.
   */
  private async messageView<T extends DirectMessage>(
    m: T,
  ): Promise<DirectMessageView<T>> {
    const { audioKey, audioDurationMs } = m;
    const rest: Partial<DirectMessage> = { ...m };
    delete rest.audioKey;
    delete rest.audioDurationMs;
    delete rest.audioContentType;
    return {
      ...(rest as Omit<T, 'audioKey' | 'audioDurationMs' | 'audioContentType'>),
      audioUrl: audioKey ? await this.storage.resolveStoredUrl(audioKey) : null,
      durationMs: audioKey ? audioDurationMs : null,
    };
  }

  /**
   * Adds, changes or clears the caller's reaction on one message.
   *
   * Only the two people in the thread may react - checked against the message's
   * own sender/recipient rather than a connection lookup, so a reaction can
   * never be attached to a conversation the caller is not part of.
   *
   * The emitted event carries the whole reaction set for the message, not a
   * delta. Deltas would need the client to hold a correct prior state, and a
   * client that missed one event while backgrounded would stay wrong forever.
   */
  /** True when either party has blocked the other - enforcement is symmetric. */
  private async blockedEitherWay(a: string, b: string): Promise<boolean> {
    const row = await this.blocks.findOne({
      where: [
        { blockerId: a, blockedId: b },
        { blockerId: b, blockedId: a },
      ],
    });
    return row !== null;
  }

  async blockDelegate(blockerId: string, blockedId: string): Promise<void> {
    if (blockerId === blockedId) {
      throw new BadRequestException('You cannot block yourself');
    }
    if (!(await this.findById(blockedId))) {
      throw new NotFoundException('Delegate not found');
    }
    // orIgnore: blocking twice is a no-op, not an error - the unique index rules
    await this.blocks
      .createQueryBuilder()
      .insert()
      .values({ blockerId, blockedId })
      .orIgnore()
      .execute();
    // A block ends the connection both ways; a blocked person staying in
    // your network (and you in theirs) would not be a block.
    await this.connections
      .createQueryBuilder()
      .delete()
      .where(
        '("fromDelegateId" = :a AND "toDelegateId" = :b) OR ("fromDelegateId" = :b AND "toDelegateId" = :a)',
        { a: blockerId, b: blockedId },
      )
      .execute();
    // and neither sees the other come and go any more
    this.presence?.revokeBetween(blockerId, blockedId);
  }

  /** Report preconditions: someone else, who exists. */
  async assertReportable(
    reporterId: string,
    reportedId: string,
  ): Promise<void> {
    if (reporterId === reportedId) {
      throw new BadRequestException('You cannot report yourself');
    }
    if (!(await this.findById(reportedId))) {
      throw new NotFoundException('Delegate not found');
    }
  }

  /**
   * The editions a delegate is part of (ticket, bookmark or attendance),
   * newest first, drafts excluded. A delegate hidden from the directory
   * shows nothing to anyone but themselves; an unknown or flagged one 404s
   * like their profile does.
   */
  async delegateEditions(
    delegateId: string,
    callerId: string,
  ): Promise<
    {
      id: string;
      name: string;
      shortName: string;
      category: string;
      city: string | null;
      startsAt: Date;
      endsAt: Date;
      /** Signed cover image, as edition cards carry it; null when none. */
      coverUrl: string | null;
    }[]
  > {
    const delegate = await this.findById(delegateId);
    if (!delegate || delegate.flagged) {
      throw new NotFoundException('Delegate not found');
    }
    if (delegateId !== callerId && delegate.directoryVisible === false) {
      return [];
    }
    const rows: {
      id: string;
      name: string;
      shortName: string;
      category: string;
      city: string | null;
      startsAt: Date;
      endsAt: Date;
      coverImage: string | null;
    }[] = await this.delegateRepository.query(
      `SELECT e.id, e.name, e."shortName", e.category, e.city, e."startsAt", e."endsAt", e."coverImage"
       FROM editions e
       WHERE e.status <> 'draft'
         AND e.id IN (
           SELECT a."editionId" FROM (${editionAudienceSql('IS NOT NULL')}) a
           WHERE a."delegateId" = $1
         )
       ORDER BY e."startsAt" DESC
       LIMIT 20`,
      [delegateId],
    );
    // the stored key signed the way edition cards sign it (local HMAC, no
    // network round trip per row); the raw key never leaves the API
    return Promise.all(
      rows.map(async ({ coverImage, ...edition }) => ({
        ...edition,
        coverUrl: await this.storage.resolveStoredUrl(coverImage),
      })),
    );
  }

  async unblockDelegate(blockerId: string, blockedId: string): Promise<void> {
    await this.blocks.delete({ blockerId, blockedId });
  }

  async myBlocks(delegateId: string): Promise<{ blockedId: string }[]> {
    const rows = await this.blocks.find({ where: { blockerId: delegateId } });
    return rows.map((r) => ({ blockedId: r.blockedId }));
  }

  async reactToMessage(
    callerId: string,
    messageId: string,
    emoji: string | null,
  ) {
    const message = await this.messages.findOneBy({ id: messageId });
    if (!message) throw new NotFoundException('Message not found');
    if (message.senderId !== callerId && message.recipientId !== callerId) {
      throw new NotFoundException('Message not found');
    }

    if (emoji === null) {
      await this.reactions.delete({ messageId, delegateId: callerId });
    } else {
      const existing = await this.reactions.findOneBy({
        messageId,
        delegateId: callerId,
      });
      if (existing) {
        await this.reactions.update({ id: existing.id }, { emoji });
      } else {
        await this.reactions.insert({ messageId, delegateId: callerId, emoji });
      }
    }

    const reactions = await this.reactionsFor([messageId]);
    const payload = {
      messageId,
      reactions: reactions.get(messageId) ?? [],
    };
    this.realtime.emitToRoom(
      [
        Rooms.dm(message.pairKey),
        Rooms.network(
          message.senderId === callerId
            ? message.recipientId
            : message.senderId,
        ),
      ],
      'dm:reaction',
      payload,
    );
    return payload;
  }

  /** Reactions grouped by message, in one query rather than one per message. */
  private async reactionsFor(
    messageIds: string[],
  ): Promise<Map<string, { delegateId: string; emoji: string }[]>> {
    const map = new Map<string, { delegateId: string; emoji: string }[]>();
    if (messageIds.length === 0) return map;
    const rows = await this.reactions.find({
      where: { messageId: In(messageIds) },
    });
    for (const r of rows) {
      const list = map.get(r.messageId) ?? [];
      list.push({ delegateId: r.delegateId, emoji: r.emoji });
      map.set(r.messageId, list);
    }
    return map;
  }

  /**
   * One page of a DM thread, oldest to newest as the chat renders it.
   *
   * The page is the NEWEST `limit` messages (optionally older than
   * `before`, an ISO createdAt from the oldest message the app already has),
   * fetched newest-first and reversed. Taking ASC + LIMIT instead returned
   * the thread's first 100 messages forever, so a long thread never showed
   * anything recent. `id` breaks createdAt ties so pages never overlap.
   */
  async listThread(
    callerId: string,
    otherId: string,
    limit = 100,
    before?: string | Date,
  ) {
    const pairKey = DelegatesService.pairKey(callerId, otherId);
    const qb = this.messages
      .createQueryBuilder('m')
      .where('m.pairKey = :p', { p: pairKey });
    if (before !== undefined) {
      const cursor = new Date(before);
      if (Number.isNaN(cursor.getTime())) {
        throw new BadRequestException('before must be an ISO date');
      }
      qb.andWhere('m.createdAt < :before', { before: cursor });
    }
    const newestFirst = await qb
      .orderBy('m.createdAt', 'DESC')
      .addOrderBy('m.id', 'DESC')
      .limit(limit)
      .getMany();
    const rows = newestFirst.reverse();

    const unreadIds = rows
      .filter((m) => m.recipientId === callerId && !m.readAt)
      .map((m) => m.id);

    if (unreadIds.length > 0) {
      await this.messages
        .createQueryBuilder()
        .update(DirectMessage)
        .set({ readAt: new Date() })
        .whereInIds(unreadIds)
        .execute();
    }

    // Attached rather than joined: a thread is read in one go, and one extra
    // query beats a join that multiplies message rows by reaction rows.
    const reactions = await this.reactionsFor(rows.map((m) => m.id));

    /**
     * Quoted text is resolved from the rows already loaded wherever possible.
     * A reply's parent is nearly always in the same page of the thread, so this
     * usually costs nothing; only a reply to something older needs a lookup.
     */
    const byId = new Map(rows.map((m) => [m.id, m]));
    const missing = rows
      .map((m) => m.replyToId)
      .filter((rid): rid is string => !!rid && !byId.has(rid));
    if (missing.length > 0) {
      const older = await this.messages.findBy({ id: In(missing) });
      for (const m of older) byId.set(m.id, m);
    }

    // voice notes signed in parallel; signing is local HMAC, no network
    return Promise.all(
      rows.map(async (m) => {
        const parent = m.replyToId ? byId.get(m.replyToId) : undefined;
        return {
          ...(await this.messageView(m)),
          reactions: reactions.get(m.id) ?? [],
          // null when the parent was deleted - the reply still renders, just
          // without a quote. That is why the FK is SET NULL, not CASCADE.
          replyTo: parent
            ? {
                id: parent.id,
                senderId: parent.senderId,
                body:
                  parent.body.slice(0, 140) ||
                  (parent.audioKey ? 'Voice note' : ''),
              }
            : null,
        };
      }),
    );
  }

  // Every thread the caller is part of, newest first: the other delegate, the
  // last message, and how many of theirs are still unread. Without this a
  // delegate can only reach a DM by navigating to the sender's chat by hand,
  // which is impossible if the sender is not in their directory listing.
  async listConversations(callerId: string): Promise<
    Array<{
      delegate: DelegateDirectoryDto;
      lastMessage: {
        body: string;
        createdAt: Date;
        senderId: string;
        /** A voice note; its body is often empty, so the inbox says so. */
        hasAudio: boolean;
      };
      unread: number;
      /** False too when the viewer may not see this delegate's presence. */
      online: boolean;
    }>
  > {
    // The last message per thread straight from Postgres (DISTINCT ON keeps
    // the first row per pairKey in the ORDER BY), and every thread's unread
    // count in one grouped query, instead of loading the caller's whole
    // message history into memory to find the same two numbers.
    const lasts: {
      pairKey: string;
      senderId: string;
      recipientId: string;
      body: string;
      createdAt: Date;
      hasAudio: boolean;
    }[] = await this.messages.query(
      `SELECT DISTINCT ON ("pairKey")
              "pairKey", "senderId", "recipientId", body, "createdAt",
              ("audioKey" IS NOT NULL) AS "hasAudio"
       FROM direct_messages
       WHERE "senderId" = $1 OR "recipientId" = $1
       ORDER BY "pairKey", "createdAt" DESC, id DESC`,
      [callerId],
    );
    if (lasts.length === 0) return [];
    const unreadRows: { pairKey: string; unread: number | string }[] =
      await this.messages.query(
        `SELECT "pairKey", COUNT(*)::int AS unread
         FROM direct_messages
         WHERE "recipientId" = $1 AND "readAt" IS NULL
         GROUP BY "pairKey"`,
        [callerId],
      );
    const unreadByPair = new Map(
      unreadRows.map((r) => [r.pairKey, Number(r.unread)]),
    );

    const threads = lasts.map((m) => ({
      otherId: m.senderId === callerId ? m.recipientId : m.senderId,
      last: { ...m, createdAt: new Date(m.createdAt) },
      unread: unreadByPair.get(m.pairKey) ?? 0,
    }));

    const others = await this.delegateRepository.find({
      where: { id: In(threads.map((t) => t.otherId)) },
    });
    const byId = new Map(others.map((d) => [d.id, d]));

    // newest thread first; threads whose other delegate is gone are dropped
    const ordered = threads
      .filter((t) => byId.has(t.otherId))
      .sort((a, b) => b.last.createdAt.getTime() - a.last.createdAt.getTime());
    // avatars signed in parallel, not one await per row
    const views = await this.withAvatars(
      ordered.map((t) =>
        DelegatesService.toDirectoryView(byId.get(t.otherId)!),
      ),
    );
    // the chat header and inbox dot, under the same privacy rules as watching;
    // skipped when presence is not wired (hand-built specs)
    const presence = this.presence
      ? await this.presenceFor(
          callerId,
          ordered.map((t) => t.otherId),
        )
      : [];
    return ordered.map((t, i) => ({
      delegate: views[i],
      lastMessage: {
        body: t.last.body,
        createdAt: t.last.createdAt,
        senderId: t.last.senderId,
        hasAudio: Boolean(t.last.hasAudio),
      },
      unread: t.unread,
      online: presence[i]?.online ?? false,
    }));
  }

  // A delegate uploads their photo straight to S3 with a one-time signed URL,
  // then saves the returned public URL through PATCH /delegates/me. Keeping the
  // bytes off the API means no multipart handling and no request size limit.
  presignAvatar(contentType: string) {
    return this.storage.presignUpload({
      folder: 'delegate-avatars',
      contentType,
    });
  }

  /**
   * Clear the profile photo and drop the object behind it. The column is
   * cleared first so a storage failure never leaves a key pointing at nothing.
   */
  /**
   * Record that the delegate finished or skipped an in-app tour. Idempotent,
   * and one atomic statement, so two devices marking the same tour cannot
   * double it. The list is capped: ids come from the app, so an unbounded
   * array would be a place to park data.
   */
  async markTourSeen(id: string, tourId: string): Promise<void> {
    if (!TOUR_ID.test(tourId)) {
      throw new BadRequestException('Unknown tour id');
    }
    await this.delegateRepository.query(
      `UPDATE delegates SET "toursSeen" = array_append("toursSeen", $2)
        WHERE id = $1 AND NOT ($2 = ANY("toursSeen")) AND cardinality("toursSeen") < $3`,
      [id, tourId, MAX_TOURS_SEEN],
    );
  }

  /**
   * After an account is deleted: every voice note in its threads (both
   * directions - the other person's copies went with the rows), then anything
   * left in their own upload folder, which catches recordings uploaded but
   * never sent. The account is already gone, so a storage failure is logged
   * for a retry by hand rather than reported to a user who no longer exists.
   */
  private async removeVoiceNotes(
    delegateId: string,
    keys: string[],
  ): Promise<void> {
    try {
      for (const key of keys) await this.storage.deleteObject(key);
      await this.storage.deletePrefix(`${VOICE_NOTE_FOLDER}/${delegateId}/`);
    } catch (error) {
      this.logger.error(
        `voice notes of deleted account ${delegateId} not removed from storage: ${(error as Error).message}`,
      );
    }
  }

  async removeAvatar(id: string): Promise<void> {
    const d = await this.getProfile(id);
    const previous = d.avatarUrl;
    if (!previous) return;
    d.avatarUrl = null;
    await this.delegateRepository.save(d);
    await this.storage.deleteObject(previous);
  }

  /**
   * Delete the account and every row that identifies this delegate.
   *
   * Required by both app stores for any app that lets people create an account
   * (Play since 2023, Apple guideline 5.1.1(v)), and the right default under
   * NDPR/GDPR. Runs in one transaction so a partial delete cannot leave an
   * orphaned session or an unreachable message thread.
   *
   * Kept deliberately: security audit events, which are a record of what
   * happened on the platform rather than profile data, and are keyed by action
   * rather than by delegate.
   */
  async deleteAccount(delegateId: string, password: string): Promise<void> {
    // passwordHash is select:false on the entity, so it has to be asked for
    const delegate = await this.delegateRepository
      .createQueryBuilder('d')
      .addSelect('d.passwordHash')
      .where('d.id = :id', { id: delegateId })
      .getOne();
    if (!delegate) throw new NotFoundException('Delegate not found');

    const ok = await bcrypt.compare(password, delegate.passwordHash);
    if (!ok) throw new UnauthorizedException('Password is incorrect');

    // same guard as revoking admin: never let the platform lose its last admin
    if (delegate.accessTier === AccessTier.ADMIN) {
      const admins = await this.delegateRepository.countBy({
        accessTier: AccessTier.ADMIN,
      });
      if (admins <= 1) {
        throw new BadRequestException(
          'Cannot delete the last remaining admin account',
        );
      }
    }

    // Voice notes in every thread they were part of: the rows go below, and
    // the recordings must not outlive them. Read before the delete; removed
    // from storage only once the delete has committed.
    const voiceNotes: { audioKey: string }[] = await this.dataSource.query(
      `SELECT "audioKey" FROM direct_messages
        WHERE ("senderId" = $1 OR "recipientId" = $1) AND "audioKey" IS NOT NULL`,
      [delegateId],
    );

    await this.dataSource.transaction(async (tx) => {
      // sessions and push first, so the account stops being reachable
      await tx.query('DELETE FROM refresh_tokens WHERE "userId" = $1', [
        delegateId,
      ]);
      await tx.query('DELETE FROM device_tokens WHERE "delegateId" = $1', [
        delegateId,
      ]);

      // anything addressed to or from them, in both directions
      await tx.query(
        'DELETE FROM direct_messages WHERE "senderId" = $1 OR "recipientId" = $1',
        [delegateId],
      );
      await tx.query(
        'DELETE FROM delegate_connections WHERE "fromDelegateId" = $1 OR "toDelegateId" = $1',
        [delegateId],
      );

      // their own activity
      await tx.query('DELETE FROM session_comments WHERE "authorId" = $1', [
        delegateId,
      ]);
      await tx.query('DELETE FROM session_bookmarks WHERE "delegateId" = $1', [
        delegateId,
      ]);
      await tx.query('DELETE FROM session_attendance WHERE "delegateId" = $1', [
        delegateId,
      ]);
      await tx.query('DELETE FROM certificates WHERE "delegateId" = $1', [
        delegateId,
      ]);
      await tx.query('DELETE FROM pitch_votes WHERE "delegateId" = $1', [
        delegateId,
      ]);
      await tx.query('DELETE FROM trivia_answers WHERE "delegateId" = $1', [
        delegateId,
      ]);

      // release the invite so the same person can register again later
      await tx.query(
        'UPDATE registration_entries SET "claimedAt" = NULL, "claimedByDelegateId" = NULL WHERE "claimedByDelegateId" = $1',
        [delegateId],
      );

      await tx.query('DELETE FROM delegates WHERE id = $1', [delegateId]);
    });

    await this.removeVoiceNotes(
      delegateId,
      voiceNotes.map((v) => v.audioKey),
    );
    this.logger.log(`account deleted ${delegateId.slice(0, 8)}…`);
  }
}
