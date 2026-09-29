import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * A session's discussion closed to new comments by an organiser (26 Sep
 * 2026). The row existing is the lock; unlocking deletes it. The thread stays
 * readable, and liking or reporting what is already there is unaffected.
 *
 * Its own table rather than a column on sessions: the lock is a moderation
 * decision about the thread, not part of the programme, and the programme
 * editor should not be able to clear it by saving a session.
 */
@Entity('discussion_locks')
export class DiscussionLock {
  @PrimaryColumn({ type: 'uuid' })
  sessionId: string;

  @Column({ type: 'uuid', nullable: true })
  lockedBy: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  lockedAt: Date;
}
