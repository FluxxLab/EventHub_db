import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { TriviaOption } from './trivia-question.entity';

@Entity('trivia_answers')
@Unique('uq_answer_delegate_question', ['delegateId', 'questionId'])
@Index('idx_trivia_answers_question', ['questionId'])
export class TriviaAnswer {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  delegateId: string;

  @Column({ type: 'uuid' })
  questionId: string;

  @Column({ type: 'enum', enum: TriviaOption })
  chosenOption: TriviaOption;

  /**
   * What this answer scored (trivia-scoring.ts). Null until its question
   * closes: a score set any earlier would reveal whether the answer was right.
   */
  @Column({ type: 'int', nullable: true })
  points: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
