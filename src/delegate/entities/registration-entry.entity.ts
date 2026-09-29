import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { AccessTier } from './delegate.entity';

@Entity('registration_entries')
@Index('idx_registration_entry_delegate', ['email'])
export class RegistrationEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255, nullable: true, unique: true })
  email: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true, unique: true })
  inviteCode: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  name: string | null;

  /**
   * What the organiser already knows about the invitee. Prefilled into the
   * sign-up form from the invite code and copied onto the delegate at
   * registration when they leave the field alone.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  organisation: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  title: string | null;

  @Column({ type: 'enum', enum: AccessTier, default: AccessTier.STANDARD })
  assignedTier: AccessTier;

  @Column({ type: 'timestamptz', nullable: true })
  claimedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  claimedByDelegateId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
