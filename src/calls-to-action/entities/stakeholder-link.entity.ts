import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export const STAKEHOLDER_LINK_STATUSES = [
  'suggested',
  'confirmed',
  'rejected',
] as const;
export type StakeholderLinkStatus = (typeof STAKEHOLDER_LINK_STATUSES)[number];

/**
 * A broad target that names no single organisation ("Federal Government",
 * "Development partners") tied to one of the event's organisations that falls
 * under it. The AI suggests links and organisers confirm them; only confirmed
 * ones count when calls are mapped to stakeholders, and a rejected one is
 * kept so it is not suggested again.
 */
@Entity('stakeholder_links')
@Index('uq_stakeholder_link', ['editionId', 'targetKey', 'organisationKey'], {
  unique: true,
})
export class StakeholderLink {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('idx_stakeholder_link_edition')
  @Column({ type: 'uuid' })
  editionId: string;

  /** The target as the calls write it. */
  @Column({ type: 'varchar', length: 200 })
  target: string;

  /** Lower case, spaces collapsed: how calls find their links. */
  @Column({ type: 'varchar', length: 200 })
  targetKey: string;

  /** One of the organisations the event's delegates wrote. */
  @Column({ type: 'varchar', length: 255 })
  organisation: string;

  @Column({ type: 'varchar', length: 255 })
  organisationKey: string;

  @Column({ type: 'varchar', length: 16 })
  status: StakeholderLinkStatus;

  /** Why the AI thinks it fits, in a line; null when added by hand. */
  @Column({ type: 'varchar', length: 300, nullable: true })
  reason: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

/** The key a target or organisation name is stored and looked up by. */
export const linkKey = (s: string) =>
  s.replace(/\s+/g, ' ').trim().toLowerCase();
