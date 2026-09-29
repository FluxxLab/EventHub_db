import {
  CreateDateColumn,
  PrimaryGeneratedColumn,
  Column,
  Entity,
  Unique,
} from 'typeorm';

@Entity('session_bookmarks')
@Unique('uq_bookmark_delegate_session', ['delegateId', 'sessionId'])
export class SessionBookmark {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  delegateId: string;

  @Column({ type: 'uuid' })
  sessionId: string;

  // A plain @Column with no default here, paired with a NOT NULL column, made
  // every bookmark insert fail with a null-constraint error - the app's
  // optimistic tick then rolled back and "save" looked dead.
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
