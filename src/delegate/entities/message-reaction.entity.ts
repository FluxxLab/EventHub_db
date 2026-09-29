import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * One reaction per delegate per message, enforced by the unique index rather
 * than by a read-then-write in the service - double-tapping an emoji on a slow
 * connection would otherwise insert twice.
 *
 * Changing emoji updates the row; removing the reaction deletes it. Both people
 * in a thread can react to the same message, which is why delegateId is part of
 * the key rather than just messageId.
 */
@Entity('message_reactions')
@Index('idx_message_reactions_unique', ['messageId', 'delegateId'], {
  unique: true,
})
export class MessageReaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  messageId: string;

  @Column({ type: 'uuid' })
  delegateId: string;

  /**
   * The emoji itself, not a code. Length 16 rather than 4: a single visible
   * emoji can be several code points once skin tone or ZWJ sequences are
   * involved, and a tighter column would truncate them into mojibake.
   */
  @Column({ type: 'varchar', length: 16 })
  emoji: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
