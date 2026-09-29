import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('speakers')
export class Speaker {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  role: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  organisation: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  avatarUrl: string | null;
}
