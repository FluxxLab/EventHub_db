import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('device_tokens')
@Index('idx_device_tokens_delegate', ['delegateId'])
export class DeviceToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  delegateId: string;

  @Column({ type: 'varchar', length: 512, unique: true })
  token: string;

  @Column({ type: 'varchar', length: 20 })
  platform: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
