import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity('delegate_connections')
@Unique('uq_connection_pair', ['fromDelegateId', 'toDelegateId'])
@Index('idx_connection_to', ['toDelegateId'])
export class DelegateConnection {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  fromDelegateId: string;

  @Column()
  toDelegateId: string;

  @Column({ type: 'boolean', default: false })
  mutual: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
