import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One delegate blocking another (App Store guideline 1.2: an app with
 * user-generated contact - this one has DMs - must let users block each other).
 *
 * Directed: A blocking B does not imply B blocking A, but enforcement is
 * symmetric - a message is refused when EITHER direction exists, because a
 * block that still lets the blocked person read your replies is not a block.
 */
@Entity('delegate_blocks')
@Index('idx_delegate_blocks_unique', ['blockerId', 'blockedId'], {
  unique: true,
})
@Index('idx_delegate_blocks_blocked', ['blockedId'])
export class DelegateBlock {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  blockerId: string;

  @Column({ type: 'uuid' })
  blockedId: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
