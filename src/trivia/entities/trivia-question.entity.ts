import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum TriviaOption {
  A = 'A',
  B = 'B',
  C = 'C',
  D = 'D',
}

export enum TriviaStatus {
  DRAFT = 'draft',
  LIVE = 'live',
  CLOSED = 'closed',
}

@Entity('trivia_questions')
@Index('idx_trivia_status', ['status'])
export class TriviaQuestion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  text: string;

  @Column({ type: 'varchar', length: 500 })
  optionA: string;

  @Column({ type: 'varchar', length: 500 })
  optionB: string;

  @Column({ type: 'varchar', length: 500 })
  optionC: string;

  @Column({ type: 'varchar', length: 500 })
  optionD: string;

  @Column({ type: 'enum', enum: TriviaOption })
  correctOption: TriviaOption;

  @Column({ type: 'text', nullable: true })
  explanation: string;

  @Column({ type: 'enum', enum: TriviaStatus, default: TriviaStatus.DRAFT })
  status: TriviaStatus;

  /** The event it belongs to; null only for rows made before events were linked (25 Sep 2026). */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  editionId: string | null;

  /**
   * When it last went live: the start of the speed bonus (trivia-scoring.ts)
   * and of the countdown phones show. Null until pushed live, and for
   * questions pushed before this existed (26 Sep 2026).
   */
  @Column({ type: 'timestamptz', nullable: true })
  liveAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
