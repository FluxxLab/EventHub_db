import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StorageService } from '../common/storage/storage.service';
import { SessionsService } from '../sessions/sessions.service';
import { CreateMaterialDto, UpdateMaterialDto } from './dto/materials.dto';
import {
  MaterialKind,
  SessionMaterial,
} from './entities/session-material.entity';

export interface MaterialView {
  id: string;
  sessionId: string;
  title: string;
  /** Fetchable as returned: storage keys are signed, external links pass through. */
  url: string;
  kind: MaterialKind;
  sizeLabel: string | null;
  sortOrder: number;
}

@Injectable()
export class MaterialsService {
  constructor(
    @InjectRepository(SessionMaterial)
    private readonly materials: Repository<SessionMaterial>,
    private readonly sessions: SessionsService,
    private readonly storage: StorageService,
  ) {}

  /** The session's materials in display order; ties fall back to when they were added. */
  async list(sessionId: string): Promise<MaterialView[]> {
    const rows = await this.materials.find({
      where: { sessionId },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
    return Promise.all(rows.map((r) => this.toView(r)));
  }

  async create(
    sessionId: string,
    dto: CreateMaterialDto,
  ): Promise<MaterialView> {
    await this.sessions.findById(sessionId);
    const saved = await this.materials.save(
      this.materials.create({
        sessionId,
        title: dto.title.trim(),
        url: dto.url.trim(),
        kind: dto.kind,
        sizeLabel: dto.sizeLabel?.trim() || null,
        sortOrder: dto.sortOrder ?? 0,
      }),
    );
    return this.toView(saved);
  }

  async update(id: string, dto: UpdateMaterialDto): Promise<MaterialView> {
    const row = await this.materials.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Material not found');
    Object.assign(row, {
      ...(dto.title !== undefined && { title: dto.title.trim() }),
      ...(dto.url !== undefined && { url: dto.url.trim() }),
      ...(dto.kind !== undefined && { kind: dto.kind }),
      ...(dto.sizeLabel !== undefined && {
        sizeLabel: dto.sizeLabel.trim() || null,
      }),
      ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
    });
    return this.toView(await this.materials.save(row));
  }

  async remove(id: string): Promise<void> {
    const result = await this.materials.delete({ id });
    if (!result.affected) throw new NotFoundException('Material not found');
  }

  private async toView(row: SessionMaterial): Promise<MaterialView> {
    return {
      id: row.id,
      sessionId: row.sessionId,
      title: row.title,
      url: (await this.storage.resolveStoredUrl(row.url)) ?? row.url,
      kind: row.kind,
      sizeLabel: row.sizeLabel,
      sortOrder: row.sortOrder,
    };
  }
}
