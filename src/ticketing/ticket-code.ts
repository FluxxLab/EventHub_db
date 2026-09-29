import { randomBytes } from 'crypto';
import type { Repository } from 'typeorm';
import type { Ticket } from './entities/ticket.entity';

/**
 * The reference printed on a ticket: `PIC-<section>-<hex>`, unique. Four hex
 * digits keep it easy to read out at a desk; a longer tail after five
 * collisions keeps it unique however many are issued.
 */
export async function uniqueTicketCode(
  tickets: Repository<Ticket>,
  section: string,
): Promise<string> {
  const prefix =
    section
      .replace(/[^A-Za-z]/g, '')
      .slice(0, 3)
      .toUpperCase() || 'GEN';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = `PIC-${prefix}-${randomBytes(2).toString('hex').toUpperCase()}`;
    if (!(await tickets.existsBy({ code }))) return code;
  }
  return `PIC-${prefix}-${randomBytes(4).toString('hex').toUpperCase()}`;
}
