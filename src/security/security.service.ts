import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  And,
  In,
  LessThan,
  MoreThanOrEqual,
  Repository,
  type FindOperator,
} from 'typeorm';
import { Delegate } from '../delegate/entities/delegate.entity';
import { EventSeverity, SecurityEvent } from './entities/security-event.entity';

export interface RecordEventInput {
  type: string;
  description: string;
  actorId?: string | null;
  severity?: EventSeverity;
  metadata?: Record<string, unknown>;
}

export interface EventQuery {
  severity?: EventSeverity;
  types?: string[];
  actorId?: string;
  from?: string;
  before?: string;
  limit?: number;
}

/** Who did it, as the log reads it. Null when there was no one, or the account is gone. */
export interface EventActor {
  id: string;
  name: string;
  email: string;
  tier: string;
}

export type SecurityEventView = SecurityEvent & { actor: EventActor | null };

@Injectable()
export class SecurityService {
  private readonly logger = new Logger(SecurityService.name);

  constructor(
    @InjectRepository(SecurityEvent)
    private readonly events: Repository<SecurityEvent>,
    @InjectRepository(Delegate)
    private readonly people: Repository<Delegate>,
  ) {}

  /**
   * Fire and forget by design: an audit failure must never
   * fail the audited action
   */
  async record(input: RecordEventInput): Promise<void> {
    try {
      await this.events.save(
        this.events.create({
          type: input.type,
          description: input.description,
          actionId: input.actorId ?? null,
          severity: input.severity ?? EventSeverity.INFO,
          metadata: input.metadata ?? null,
        }),
      );
    } catch (e) {
      this.logger.error(`audit write failed: ${input.type}`, e as Error);
    }
  }

  /**
   * Newest first, a page at a time (`before` is the last row's createdAt).
   * Each row names its actor: one lookup for the page, not one per row.
   */
  async list(query: EventQuery): Promise<SecurityEventView[]> {
    const createdAt: FindOperator<Date>[] = [];
    if (query.from) createdAt.push(MoreThanOrEqual(new Date(query.from)));
    if (query.before) createdAt.push(LessThan(new Date(query.before)));
    const rows = await this.events.find({
      where: {
        ...(query.severity && { severity: query.severity }),
        ...(query.types?.length && { type: In(query.types) }),
        ...(query.actorId && { actionId: query.actorId }),
        ...(createdAt.length && {
          createdAt: createdAt.length === 1 ? createdAt[0] : And(...createdAt),
        }),
      },
      order: { createdAt: 'DESC' },
      take: query.limit ?? 50,
    });

    const ids = [
      ...new Set(rows.map((r) => r.actionId).filter((id) => id !== null)),
    ];
    const people = ids.length
      ? await this.people.find({
          where: { id: In(ids) },
          select: { id: true, name: true, email: true, accessTier: true },
        })
      : [];
    const byId = new Map(
      people.map((p) => [
        p.id,
        { id: p.id, name: p.name, email: p.email, tier: p.accessTier },
      ]),
    );
    return rows.map((r) => ({
      ...r,
      actor: (r.actionId && byId.get(r.actionId)) || null,
    }));
  }
}
