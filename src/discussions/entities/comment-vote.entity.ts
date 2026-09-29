import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum VoteValue {
  LIKE = 'like',
  DISLIKE = 'dislike',
}

/**
 * One row per delegate per comment. The unique index is the rule: "one vote per
 * delegate per comment" is enforced by the database rather than by a read-then-
 * write in the service, which would race two taps from the same delegate.
 *
 * Changing a like to a dislike updates this row; removing a vote deletes it.
 * The denormalised counters on session_comments are derived from this table, so
 * it stays the source of truth if they ever drift.
 */
@Entity('comment_votes')
@Index('idx_comment_votes_unique', ['commentId', 'delegateId'], {
  unique: true,
})
export class CommentVote {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  commentId: string;

  @Column({ type: 'uuid' })
  delegateId: string;

  @Column({ type: 'varchar', length: 10 })
  value: VoteValue;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
