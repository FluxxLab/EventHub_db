import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** Where the event was recorded. The app reports it; nothing derives it. */
export const ANALYTICS_PLATFORMS = ['ios', 'android', 'web'] as const;
export type AnalyticsPlatform = (typeof ANALYTICS_PLATFORMS)[number];

/**
 * One thing a delegate did in the app: a screen opened, a feature used.
 *
 * Append-only and deliberately loose - `name` plus a bag of `props` - so
 * the app can add an event without a migration. The summary endpoint reads
 * only two shapes (`screen_view` with `props.path`, `feature_use` with
 * `props.feature`); everything else is kept for the report author with a
 * SQL client. `delegateId` is nullable so a row survives the account being
 * deleted without an update pass over the table.
 *
 * `occurredAt` is when it happened on the device; `receivedAt` is when the
 * batch reached us. They drift apart on venue wifi, and the report wants the
 * first.
 */
@Entity('analytics_events')
@Index('idx_analytics_events_delegate', ['delegateId'])
@Index('idx_analytics_events_name', ['name'])
@Index('idx_analytics_events_occurred', ['occurredAt'])
export class AnalyticsEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  delegateId: string | null;

  @Column({ type: 'varchar', length: 60 })
  name: string;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  props: Record<string, unknown>;

  @Column({ type: 'varchar', length: 10 })
  platform: AnalyticsPlatform;

  @Column({ type: 'varchar', length: 20, nullable: true })
  appVersion: string | null;

  @Column({ type: 'timestamptz' })
  occurredAt: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  receivedAt: Date;
}
