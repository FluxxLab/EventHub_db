import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One delegate having opened one notification. A row per read rather than a
 * flag on the notification, because a broadcast is one row read by thousands
 * of people at different times. The inbox joins against this to mark what
 * the caller has already seen; absence of a row is "unread".
 */
@Entity('notification_reads')
@Index('idx_notification_reads_pair', ['delegateId', 'notificationId'], {
  unique: true,
})
export class NotificationRead {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  delegateId: string;

  @Column({ type: 'uuid' })
  notificationId: string;

  @CreateDateColumn({ type: 'timestamptz' })
  readAt: Date;
}
