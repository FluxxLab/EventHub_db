import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum AudienceSegment {
  ALL = 'all',
  VIP = 'vip',
  PRESS = 'press',
  SPEAKERS = 'speakers',
  VOLUNTEERS = 'volunteers',
}

@Entity('notifications')
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'enum', enum: AudienceSegment, default: AudienceSegment.ALL })
  segment: AudienceSegment;

  /**
   * Set when this notification is for one delegate rather than a segment -
   * "someone added you to their network" and the like.
   *
   * Segment stays populated for these (nothing reads it, and the column is not
   * nullable), but delegateId wins: the inbox query matches this row to its one
   * recipient and to nobody else. Null is the normal broadcast case.
   */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  delegateId: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  category: string | null;

  /**
   * Where this announcement leads, if anywhere.
   *
   * Two fields rather than one generic link: a session is something the apps
   * can open natively and keep the delegate inside the app, while a URL has to
   * leave it. Collapsing both into one string would mean every client guessing
   * which it had been handed.
   *
   * Most announcements have neither, and that is a legitimate state: "lunch is
   * served" is the whole message.
   */
  @Column({ type: 'uuid', nullable: true })
  sessionId: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  linkUrl: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt: Date | null;

  /** Also sent on WhatsApp to the segment's delegates who opted in. */
  @Column({ type: 'boolean', default: false })
  whatsapp: boolean;

  /** The event it belongs to; null only for rows made before events were linked (25 Sep 2026). */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  editionId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
