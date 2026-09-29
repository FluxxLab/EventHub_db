/**
 * The closed set of session types, and the normaliser that maps what an
 * organiser actually typed onto it.
 *
 * The column was free text, and GS-26's agenda arrived with "Plenary
 * Session", "Plenary (Parallel Session)", "Roundtable Discussion", "Closing
 * Remarks" and a dozen more spellings of a handful of ideas. Every client
 * then grew its own switch statement to colour and group them, and each
 * disagreed with the others. One list here, one label per value, one
 * function that turns a variant into a value: the DTOs run it on the way in,
 * the migration runs it over the rows already stored, and the quality report
 * counts whatever still slips past.
 */
export const SESSION_TYPES = [
  'plenary',
  'parallel',
  'panel',
  'roundtable',
  'workshop',
  'keynote',
  'fireside',
  'networking',
  'break',
  'ceremony',
  'awards',
  'closing',
  'other',
] as const;

export type SessionType = (typeof SESSION_TYPES)[number];

export const SESSION_TYPE_LABELS: Record<SessionType, string> = {
  plenary: 'Plenary',
  parallel: 'Parallel session',
  panel: 'Panel',
  roundtable: 'Roundtable',
  workshop: 'Workshop',
  keynote: 'Keynote',
  fireside: 'Fireside chat',
  networking: 'Networking',
  break: 'Break',
  ceremony: 'Ceremony',
  awards: 'Awards',
  closing: 'Closing',
  other: 'Other',
};

/** `[{ value, label }]` for pickers, in the order the list above declares. */
export function sessionTypeOptions(): { value: SessionType; label: string }[] {
  return SESSION_TYPES.map((value) => ({
    value,
    label: SESSION_TYPE_LABELS[value],
  }));
}

/**
 * Keyword rules, tried in order; the first hit wins.
 *
 * Order carries the judgement calls. "Plenary (Parallel Session)" is a
 * parallel session that happens to sit in the plenary strand, so parallel
 * outranks plenary. "Closing Plenary" is still a plenary. "Award Ceremony"
 * is the awards, not a generic ceremony. "Networking Lunch" is networking
 * before it is a break. Word boundaries keep "breakout" from matching
 * "break" - a breakout is a parallel session.
 */
const RULES: ReadonlyArray<readonly [RegExp, SessionType]> = [
  [/\bparallel\b/, 'parallel'],
  [/\bbreakout\b/, 'parallel'],
  [/\bplenary\b/, 'plenary'],
  [/\bkeynote\b/, 'keynote'],
  [/\bfireside\b/, 'fireside'],
  [/\bround ?tables?\b/, 'roundtable'],
  [/\bpanel\b/, 'panel'],
  [/\bworkshops?\b/, 'workshop'],
  [/\bclosing\b/, 'closing'],
  [/\bawards?\b/, 'awards'],
  [/\b(opening|ceremony|ceremonies)\b/, 'ceremony'],
  [/\bnetworking\b/, 'networking'],
  [/\b(break|lunch|tea|coffee|breakfast|refreshments?)\b/, 'break'],
];

/**
 * The canonical value for a free-text type, or null when nothing in the
 * text is recognisable. Case and surrounding whitespace never matter, and an
 * exact canonical value always maps to itself.
 */
export function normaliseSessionType(input: string): SessionType | null {
  const text = input.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text) return null;
  if ((SESSION_TYPES as readonly string[]).includes(text)) {
    return text as SessionType;
  }
  for (const [pattern, type] of RULES) {
    if (pattern.test(text)) return type;
  }
  return null;
}

/**
 * A room name that means "we do not know yet".
 *
 * Captions are routed by room (the caption operator picks a room, not a
 * session), so two sessions filed under "TBC" would receive each other's
 * captions. Refusing the placeholder at the door is cheaper than untangling
 * that live.
 */
export const ROOM_PLACEHOLDER = /^(tbc|tba|tbd|n\/a|none|-)?$/i;

export const ROOM_PLACEHOLDER_MESSAGE =
  'Room must be a real room name; placeholders like TBC cannot receive captions';

/** Trimmed, with runs of inner whitespace collapsed to one space. */
export function normaliseRoom(input: string): string {
  return input.trim().replace(/\s+/g, ' ');
}

export function isPlaceholderRoom(input: string): boolean {
  return ROOM_PLACEHOLDER.test(normaliseRoom(input));
}
