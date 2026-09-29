import { BadRequestException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcrypt';
import type { Repository } from 'typeorm';
import { AccessTier, Delegate } from '../delegate/entities/delegate.entity';

/**
 * Who each ticket in an order is for. A buyer paying for colleagues names
 * every place at checkout; at settlement each place becomes its own ticket in
 * that person's account, so the gate, the directory and certificates know
 * who is who. A holder with no account gets one created, unclaimed: no
 * password anyone knows, no consent recorded, hidden from the directory
 * until they sign up with that email and prove the inbox is theirs.
 */

/** Tag on an account created for a ticket holder and not yet claimed. */
export const TICKET_HOLDER_TAG = 'ticket-holder';

export interface OrderAttendee {
  ticketTypeId: string;
  name: string;
  /** Lower-cased and trimmed. */
  email: string;
}

/**
 * Normalises and checks the attendee list against the order lines: one entry
 * per place, the right number per ticket type, a name each, and no email
 * twice (two places for one person is almost always a typo, and it would
 * make the gate unable to say whose ticket it is).
 */
export function checkAttendees(
  lines: { ticketTypeId: string; quantity: number }[],
  attendees: { ticketTypeId: string; name: string; email: string }[],
): OrderAttendee[] {
  const clean = attendees.map((a) => ({
    ticketTypeId: a.ticketTypeId,
    name: a.name.trim(),
    email: a.email.trim().toLowerCase(),
  }));
  if (clean.some((a) => !a.name)) {
    throw new BadRequestException('Every ticket needs the holder’s name');
  }
  const places = new Map<string, number>();
  for (const line of lines) {
    places.set(
      line.ticketTypeId,
      (places.get(line.ticketTypeId) ?? 0) + line.quantity,
    );
  }
  const named = new Map<string, number>();
  for (const a of clean) {
    named.set(a.ticketTypeId, (named.get(a.ticketTypeId) ?? 0) + 1);
  }
  const mismatch =
    places.size !== named.size ||
    [...places].some(([id, count]) => named.get(id) !== count);
  if (mismatch) {
    throw new BadRequestException(
      'Name one person for every ticket in the order',
    );
  }
  const seen = new Set<string>();
  for (const a of clean) {
    if (seen.has(a.email)) {
      throw new BadRequestException(
        `${a.email} is on more than one ticket; each person needs their own email`,
      );
    }
    seen.add(a.email);
  }
  return clean;
}

/**
 * An account made for a ticket and never taken over by the person: tagged,
 * no password of their own, no consent recorded. Only such an account is
 * removed when its last ticket moves to someone else.
 */
export function isUnclaimedHolder(
  delegate: Pick<Delegate, 'tags' | 'hasChosenPassword' | 'consentAt'>,
): boolean {
  return (
    (delegate.tags ?? []).includes(TICKET_HOLDER_TAG) &&
    !delegate.hasChosenPassword &&
    !delegate.consentAt
  );
}

/** A password nobody knows, for an account made on someone's behalf. */
export const placeholderHash = () =>
  bcrypt.hash(randomBytes(32).toString('hex'), 10);

/**
 * The account a named place goes to. An existing account (any state) is
 * used as is. Otherwise one is created unclaimed: a password nobody holds,
 * no consent recorded, tagged so registration can hand it to whoever proves
 * the inbox, and so the directory and search leave it out until then.
 * `passwordHash` lets the caller hash before taking row locks (bcrypt is slow).
 */
export async function resolveHolder(
  delegates: Repository<Delegate>,
  attendee: { name: string; email: string },
  passwordHash?: string,
): Promise<{ delegate: Delegate; created: boolean }> {
  const existing = await delegates.findOne({
    where: { email: attendee.email },
  });
  if (existing) return { delegate: existing, created: false };
  const delegate = await delegates.save(
    delegates.create({
      name: attendee.name,
      email: attendee.email,
      passwordHash: passwordHash ?? (await placeholderHash()),
      accessTier: AccessTier.STANDARD,
      pendingReview: false,
      hasChosenPassword: false,
      consentAt: null,
      tags: [TICKET_HOLDER_TAG],
      phone: null,
      avatarUrl: null,
      interests: [],
      tracks: [],
    }),
  );
  return { delegate, created: true };
}

/** One holder to email once a ticket is theirs. */
export interface HolderNotice {
  email: string;
  name: string;
  /** Their account was created for this ticket and is waiting to be claimed. */
  created: boolean;
  buyerName: string;
  tierName: string;
}

/**
 * "Someone got you a ticket": the email a holder gets at settlement and when
 * a ticket is passed to them. A holder whose account was made for them is
 * told how to claim it.
 */
export function holderNoticeText(
  n: HolderNotice,
  eventName: string,
): { subject: string; text: string } {
  const how = n.created
    ? `Download PIC Events and sign up with this email address (${n.email}) to see your ticket and entry QR. Your account is already waiting for you; nothing is shared until you sign up.`
    : `Open PIC Events and sign in with ${n.email} to see your ticket and entry QR under Tickets.`;
  return {
    subject: `Your ticket to ${eventName}`,
    text: `Hello ${n.name},

${n.buyerName} has got you a ${n.tierName} ticket to ${eventName}.

${how}

Show the QR at the entrance. If you were not expecting this, you can ignore this email.`,
  };
}
