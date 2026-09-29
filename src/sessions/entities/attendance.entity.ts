import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

// Proof a delegate was in a session while it was actually running. Written when
// they join the session's socket room and the session is LIVE - opening the page
// for a scheduled or finished session is not attendance.
//
// This is what gates the FR-16 certificate: participation, not registration.
@Entity('session_attendance')
@Index('idx_attendance_pair', ['delegateId', 'sessionId'], { unique: true })
@Index('idx_attendance_delegate', ['delegateId'])
export class SessionAttendance {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  delegateId: string;

  @Column({ type: 'uuid' })
  sessionId: string;

  @CreateDateColumn({ type: 'timestamptz' })
  firstSeenAt: Date;
}
