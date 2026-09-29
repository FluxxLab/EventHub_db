import { BadRequestException } from '@nestjs/common';
import { checkAttendees } from './ticket-holders';

/**
 * Naming who each ticket is for is what lets the gate, the directory and the
 * certificates tell people apart. The rules: one name and email per place,
 * the right count per ticket type, and no email twice.
 */
const STANDARD = 'aaaa1111-1111-4111-8111-111111111111';
const VIP = 'aaaa2222-2222-4222-8222-222222222222';

describe('checkAttendees', () => {
  const lines = [
    { ticketTypeId: STANDARD, quantity: 2 },
    { ticketTypeId: VIP, quantity: 1 },
  ];

  it('normalises emails and names', () => {
    expect(
      checkAttendees(lines, [
        {
          ticketTypeId: STANDARD,
          name: ' Ada Okafor ',
          email: ' Ada@Example.com ',
        },
        {
          ticketTypeId: STANDARD,
          name: 'Grace Obi',
          email: 'grace@example.org',
        },
        { ticketTypeId: VIP, name: 'Tunde Bakare', email: 'tunde@nesg.org' },
      ]),
    ).toEqual([
      { ticketTypeId: STANDARD, name: 'Ada Okafor', email: 'ada@example.com' },
      { ticketTypeId: STANDARD, name: 'Grace Obi', email: 'grace@example.org' },
      { ticketTypeId: VIP, name: 'Tunde Bakare', email: 'tunde@nesg.org' },
    ]);
  });

  it('refuses a place left unnamed', () => {
    expect(() =>
      checkAttendees(lines, [
        { ticketTypeId: STANDARD, name: 'Ada', email: 'a@x.org' },
        { ticketTypeId: VIP, name: 'Tunde', email: 't@x.org' },
      ]),
    ).toThrow(
      new BadRequestException('Name one person for every ticket in the order'),
    );
  });

  it('refuses a person put on the wrong ticket type', () => {
    expect(() =>
      checkAttendees(lines, [
        { ticketTypeId: STANDARD, name: 'Ada', email: 'a@x.org' },
        { ticketTypeId: VIP, name: 'Grace', email: 'g@x.org' },
        { ticketTypeId: VIP, name: 'Tunde', email: 't@x.org' },
      ]),
    ).toThrow(BadRequestException);
  });

  it('refuses the same email on two tickets, whatever its case', () => {
    expect(() =>
      checkAttendees(lines, [
        { ticketTypeId: STANDARD, name: 'Ada', email: 'ada@x.org' },
        { ticketTypeId: STANDARD, name: 'Ada again', email: 'ADA@x.org' },
        { ticketTypeId: VIP, name: 'Tunde', email: 't@x.org' },
      ]),
    ).toThrow(/more than one ticket/);
  });

  it('refuses a blank name', () => {
    expect(() =>
      checkAttendees(
        [{ ticketTypeId: VIP, quantity: 1 }],
        [{ ticketTypeId: VIP, name: '   ', email: 't@x.org' }],
      ),
    ).toThrow(/holder’s name/);
  });
});
