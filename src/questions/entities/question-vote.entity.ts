import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One row per delegate per question. The unique index is the rule - "one
 * upvote per delegate" is enforced by the database rather than by a
 * read-then-write in the service, which would race two taps from the same
 * delegate. Removing the upvote deletes the row.
 */
@Entity('question_votes')
@Index('idx_question_votes_unique', ['questionId', 'delegateId'], {
  unique: true,
})
export class QuestionVote {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  questionId: string;

  @Column({ type: 'uuid' })
  delegateId: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
