import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('session_comments')
@Index('idx_comments_session_created', ['sessionId', 'createdAt'])
export class SessionComment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  sessionId: string;

  @Column({ type: 'uuid' })
  authorId: string;

  @Column({ type: 'varchar', length: 2000 })
  body: string;

  /**
   * The id the app gave the comment when it was written. A retry after a
   * timeout, or a comment queued while offline, carries the same id, so it is
   * saved once (unique per author). Null for comments from older builds.
   */
  @Column({ type: 'uuid', nullable: true })
  clientId: string | null;

  @Column({ type: 'boolean', default: false })
  flagged: boolean;

  /**
   * Denormalised counters, maintained alongside comment_votes. A thread render
   * reads every comment at once, so counting votes per row would put a join and
   * an aggregate on the hot path for a number that changes rarely.
   */
  @Column({ type: 'int', default: 0 })
  likes: number;

  @Column({ type: 'int', default: 0 })
  dislikes: number;

  @Column({ type: 'timestamptz', nullable: true })
  hiddenAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  hiddenBy: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
