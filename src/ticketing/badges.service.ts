import { BadRequestException, Injectable } from '@nestjs/common';
import { StorageService } from '../common/storage/storage.service';
import { DataSource } from 'typeorm';
import { Edition } from '../editions/entities/edition.entity';
import { EditionsService } from '../editions/editions.service';
import { AdmissionService } from './admission.service';
import {
  BADGE_LIST_LIMIT,
  type BadgeDesign,
  type BadgeDesignView,
  type BadgeHolder,
} from './badge-design';
import type { SaveBadgeDesignDto } from './dto/badge.dto';

interface HolderRow {
  ticketId: string;
  code: string;
  name: string;
  title: string | null;
  organisation: string | null;
  country: string | null;
  avatarUrl: string | null;
  tierName: string;
  ticketTypeId: string;
  section: string;
  quantity: number;
  qrVersion: string | number | null;
  admitted: string | number;
}

/**
 * Name badges for an edition's ticket holders. The QR on a badge is the
 * ticket's own signed admission payload, so the badge is the ticket at the
 * door; that is why the list is for the edition's staff only and every
 * fetch is audited.
 */
@Injectable()
export class BadgesService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly editions: EditionsService,
    private readonly admission: AdmissionService,
    private readonly storage: StorageService,
  ) {}

  async design(editionId: string): Promise<BadgeDesignView | null> {
    await this.editions.findById(editionId);
    const row = await this.dataSource.getRepository(Edition).findOne({
      where: { id: editionId },
      select: { id: true, badgeDesign: true },
    });
    return row?.badgeDesign ? this.view(row.badgeDesign) : null;
  }

  /** Designs saved before artwork existed have neither field; the link to show the artwork is fresh each read. */
  private async view(design: BadgeDesign): Promise<BadgeDesignView> {
    const artwork = design.artwork ?? null;
    return {
      ...design,
      artwork,
      layout: design.layout ?? null,
      artworkUrl: artwork ? await this.storage.presignRead(artwork) : null,
    };
  }

  /** Where the console PUTs artwork (PNG or JPG) before saving the design with the returned key. */
  presignArtwork(contentType: string) {
    return this.storage.presignUpload({ folder: 'badges', contentType });
  }

  async saveDesign(
    editionId: string,
    dto: SaveBadgeDesignDto,
  ): Promise<BadgeDesignView> {
    await this.editions.findById(editionId);
    if (dto.artwork && !dto.layout) {
      throw new BadRequestException(
        'Say where the photo, name and QR go on the artwork',
      );
    }
    const design: BadgeDesign = {
      size: dto.size,
      accent: dto.accent.toLowerCase(),
      fields: dto.fields,
      // one colour per tier: the last one given wins
      tierColours: [
        ...new Map(
          dto.tierColours.map((t) => [
            t.tier.trim(),
            { tier: t.tier.trim(), colour: t.colour.toLowerCase() },
          ]),
        ).values(),
      ],
      artwork: dto.artwork ?? null,
      layout: dto.artwork && dto.layout ? dto.layout : null,
    };
    await this.dataSource
      .getRepository(Edition)
      .update({ id: editionId }, { badgeDesign: design });
    return this.view(design);
  }

  /**
   * Every ticket of the edition as a badge, by holder name. The holder's
   * account name wins over the name typed at checkout, since they may have
   * corrected it since.
   */
  async holders(
    editionId: string,
    ticketTypeId?: string,
  ): Promise<BadgeHolder[]> {
    await this.editions.findById(editionId);
    const qb = this.dataSource
      .createQueryBuilder()
      .select('t.id', 'ticketId')
      .addSelect('t.code', 'code')
      .addSelect(`COALESCE(NULLIF(d.name, ''), t."guestName")`, 'name')
      .addSelect('d.title', 'title')
      .addSelect('d.organisation', 'organisation')
      .addSelect('d.country', 'country')
      .addSelect('d."avatarUrl"', 'avatarUrl')
      .addSelect('t."tierName"', 'tierName')
      .addSelect('t."ticketTypeId"', 'ticketTypeId')
      .addSelect('t.section', 'section')
      .addSelect('t.quantity', 'quantity')
      .addSelect('t."qrVersion"', 'qrVersion')
      .addSelect(
        '(SELECT COUNT(*) FROM ticket_admissions a WHERE a."ticketId" = t.id)',
        'admitted',
      )
      .from('tickets', 't')
      .leftJoin('delegates', 'd', 'd.id = t."delegateId"')
      .where('t."editionId" = :editionId', { editionId })
      .orderBy('name', 'ASC')
      .addOrderBy('t.code', 'ASC')
      .limit(BADGE_LIST_LIMIT);
    if (ticketTypeId) {
      qb.andWhere('t."ticketTypeId" = :ticketTypeId', { ticketTypeId });
    }
    const rows = await qb.getRawMany<HolderRow>();
    // signing is local (no call to S3), so a few thousand is quick
    const photos = await Promise.all(
      rows.map((r) => this.storage.resolveAvatar(r.avatarUrl)),
    );
    return rows.map((r, i) => ({
      ticketId: r.ticketId,
      code: r.code,
      name: r.name,
      title: r.title,
      organisation: r.organisation,
      country: r.country,
      photo: photos[i] ?? null,
      tierName: r.tierName,
      ticketTypeId: r.ticketTypeId,
      section: r.section,
      quantity: Number(r.quantity),
      qr: this.admission.qrFor(r.ticketId, Number(r.qrVersion ?? 0)),
      admitted: Number(r.admitted),
    }));
  }
}
