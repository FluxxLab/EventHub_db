import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * An address that asked not to get campaign emails. Keyed by the address,
 * not an account, since ticket holders need not have one. Transactional
 * mail (sign-in codes, tickets) still reaches it.
 */
@Entity('email_suppressions')
export class EmailSuppression {
  @PrimaryColumn({ type: 'varchar', length: 255 })
  email: string;

  /** `page`: the confirmation page; `one_click`: the mail app's own button. */
  @Column({ type: 'varchar', length: 20 })
  source: 'page' | 'one_click';

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
