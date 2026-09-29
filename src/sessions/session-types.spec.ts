import {
  SESSION_TYPES,
  SESSION_TYPE_LABELS,
  isPlaceholderRoom,
  normaliseRoom,
  normaliseSessionType,
  sessionTypeOptions,
} from './session-types';

/**
 * The normaliser is what turns a dozen spellings from the agenda spreadsheet
 * into the closed list every client groups by. Each case here is a spelling
 * that actually appeared in GS-26's data or the report's examples; the
 * judgement calls (parallel over plenary, closing over plenary's absence,
 * awards over ceremony) are pinned so a rule reorder cannot silently flip
 * them.
 */
describe('normaliseSessionType', () => {
  it.each(SESSION_TYPES)('maps the canonical value %s to itself', (type) => {
    expect(normaliseSessionType(type)).toBe(type);
  });

  it('ignores case and surrounding whitespace on a canonical value', () => {
    expect(normaliseSessionType('  Plenary ')).toBe('plenary');
    expect(normaliseSessionType('KEYNOTE')).toBe('keynote');
  });

  it.each([
    ['Plenary Session', 'plenary'],
    ['Opening Plenary', 'plenary'],
    ['Plenary (Parallel Session)', 'parallel'],
    ['Parallel Sessions', 'parallel'],
    ['Breakout Session', 'parallel'],
    ['Roundtable Discussion', 'roundtable'],
    ['Round Table', 'roundtable'],
    ['Closing Remarks', 'closing'],
    ['Closing Ceremony', 'closing'],
    ['Award', 'awards'],
    ['Awards Night', 'awards'],
    ['Award Ceremony', 'awards'],
    ['Opening Ceremony', 'ceremony'],
    ['Opening', 'ceremony'],
    ['Tea Break', 'break'],
    ['Lunch', 'break'],
    ['Coffee', 'break'],
    ['Networking Lunch', 'networking'],
    ['Panel Discussion', 'panel'],
    ['Fireside Chat', 'fireside'],
    ['Keynote Address', 'keynote'],
    ['Workshops', 'workshop'],
  ])('maps "%s" to %s', (input, expected) => {
    expect(normaliseSessionType(input)).toBe(expected);
  });

  it('returns null for anything it cannot place', () => {
    expect(normaliseSessionType('Miscellaneous')).toBeNull();
    expect(normaliseSessionType('')).toBeNull();
    expect(normaliseSessionType('   ')).toBeNull();
  });

  it('does not let "breakout" fall into break', () => {
    // word boundaries: a breakout is a parallel session, not a coffee break
    expect(normaliseSessionType('Breakout')).toBe('parallel');
  });

  it('has a label for every value, in list order', () => {
    const options = sessionTypeOptions();
    expect(options.map((o) => o.value)).toEqual([...SESSION_TYPES]);
    for (const o of options) {
      expect(o.label).toBe(SESSION_TYPE_LABELS[o.value]);
      expect(o.label.length).toBeGreaterThan(0);
    }
  });
});

/**
 * Captions are routed by room, so a placeholder room is not "unknown", it is
 * "shared with every other session that has one". The rule has to catch the
 * spellings organisers actually use and nothing else.
 */
describe('room placeholders', () => {
  it('trims and collapses inner whitespace', () => {
    expect(normaliseRoom('  Hestel   Hall ')).toBe('Hestel Hall');
    expect(normaliseRoom('Room\t2B')).toBe('Room 2B');
  });

  it.each(['TBC', 'tbc', 'TBA', 'tbd', 'N/A', 'n/a', 'None', '-', '', '   '])(
    'treats "%s" as a placeholder',
    (room) => {
      expect(isPlaceholderRoom(room)).toBe(true);
    },
  );

  it.each(['Hestel Hall', 'TBC Suite', 'Room 2B', 'Main Auditorium', '--'])(
    'accepts "%s" as a real room',
    (room) => {
      expect(isPlaceholderRoom(room)).toBe(false);
    },
  );
});
