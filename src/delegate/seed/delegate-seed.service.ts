import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import Redis from 'ioredis';
import { Repository } from 'typeorm';
import { REDIS } from '../../common/redis/redis.module';
import { Delegate } from '../entities/delegate.entity';
import { generate } from './delegate-seed.data';
import { TICKET_HOLDER_TAG } from '../../ticketing/ticket-holders';

/**
 * A slow trickle of seeded delegates, one every N minutes, until a target
 * is reached - so the registration count climbs the way a real one does
 * instead of jumping by 150 at once.
 *
 * Off unless SEED_DELEGATES_TARGET is set. Counts what is already there on
 * every tick rather than remembering, so a restart or a redeploy picks up
 * where it left off and never overshoots. A short Redis lock per tick keeps
 * two API instances from inserting the same minute's delegate twice.
 *
 * A seeded row is one with `hasChosenPassword` false - that is what counts
 * it toward the target here, what `pnpm seed:delegates -- --purge` deletes,
 * and what stops it ever receiving a password-reset email (see
 * AuthService.forgotPassword). A row seeded before that column existed still
 * only carries the legacy `seed` tag, so both are checked everywhere a row's
 * seeded-ness matters - see the comment on the query below.
 */
@Injectable()
export class DelegateSeedService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DelegateSeedService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(Delegate)
    private readonly delegates: Repository<Delegate>,
    @Inject(REDIS)
    private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {}

  get target(): number {
    return Number(this.config.get('SEED_DELEGATES_TARGET') ?? 0) || 0;
  }

  get intervalMs(): number {
    const minutes = Number(
      this.config.get('SEED_DELEGATES_INTERVAL_MIN') ?? 20,
    );
    return Math.max(1, minutes || 20) * 60_000;
  }

  onModuleInit(): void {
    if (this.target <= 0) return;
    this.logger.log(
      `seeding delegates: one every ${this.intervalMs / 60_000} min until ${this.target}`,
    );
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One delegate, if we are below target and no other instance got here first. */
  async tick(): Promise<boolean> {
    try {
      // A row written before `hasChosenPassword` existed still only carries
      // the old `seed` tag, and nothing back-fills the new column onto it -
      // both are checked so a marker change never lets the trickle recount
      // an already-seeded batch as unseeded and overshoot the target.
      const seededRows = await this.delegates
        .createQueryBuilder('d')
        .select('d.name')
        // Google sign-in accounts and unclaimed ticket-holder accounts also
        // have no chosen password; they are real people, not seed rows
        .where(
          `(d."hasChosenPassword" = false AND d."googleSub" IS NULL AND NOT (:holder = ANY(d.tags))) OR 'seed' = ANY(d.tags)`,
          { holder: TICKET_HOLDER_TAG },
        )
        .getMany();
      if (seededRows.length >= this.target) {
        this.logger.log(`seed target ${this.target} reached; stopping`);
        this.onModuleDestroy();
        return false;
      }

      // the lock lives for most of the interval, so a second instance ticking
      // in the same window skips rather than doubles
      const lock = await this.redis.set(
        'seed:delegates:tick',
        '1',
        'PX',
        Math.floor(this.intervalMs * 0.8),
        'NX',
      );
      if (lock !== 'OK') return false;

      // a roster name already used by any previous run - this process's own
      // earlier ticks, an older run before a restart, or the CLI script -
      // must never be drawn again
      const usedNames = new Set(seededRows.map((d) => d.name));
      const [row] = generate(1, usedNames);
      await this.delegates.save(
        this.delegates.create({
          ...row,
          passwordHash: await bcrypt.hash(randomBytes(32).toString('hex'), 10),
          hasChosenPassword: false,
          pendingReview: false,
          consentAt: new Date(),
          phone: null,
          avatarUrl: null,
        }),
      );
      this.logger.log(
        `seeded ${row.name} (${seededRows.length + 1}/${this.target})`,
      );
      return true;
    } catch (e) {
      this.logger.warn(`seed tick failed: ${e}`);
      return false;
    }
  }
}
