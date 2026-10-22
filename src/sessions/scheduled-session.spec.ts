import { pickScheduled } from './scheduled-session';

const at = (hhmm: string) => new Date(`2026-10-22T${hhmm}:00Z`);
const s = (id: string, from: string, to: string) => ({
  id,
  startsAt: at(from),
  endsAt: at(to),
});

describe('the session the programme has in a room now', () => {
  const day = [
    s('keynote', '09:00', '09:30'),
    s('panel', '09:30', '10:30'),
    s('fireside', '10:45', '11:15'),
  ];

  it('is the one on now', () => {
    expect(pickScheduled(day, at('09:50'))?.id).toBe('panel');
  });

  it('is the latest-starting when sessions nest', () => {
    expect(
      pickScheduled(
        [s('block', '09:00', '12:00'), s('talk', '10:00', '10:20')],
        at('10:05'),
      )?.id,
    ).toBe('talk');
  });

  it('is the next one about to start, then the last one running over', () => {
    expect(pickScheduled(day, at('10:40'))?.id).toBe('fireside'); // five minutes early
    expect(pickScheduled([s('panel', '09:30', '10:30')], at('10:45'))?.id).toBe(
      'panel',
    ); // fifteen over
  });

  it('is nothing when the room has nothing near the time', () => {
    expect(pickScheduled(day, at('13:00'))).toBeNull();
    expect(pickScheduled([], at('09:50'))).toBeNull();
  });
});
