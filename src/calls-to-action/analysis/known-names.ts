/**
 * Spelling names the way people at the event spell them.
 *
 * Captions mishear surnames ("Agbajogo" for "Agbajogu") and the AI shortens
 * first names ("Chris" for "Christopher"), so the same person can appear on
 * cards under several spellings. A name the AI finds is matched against the
 * names already known for the event (the programme's speakers, and names a
 * person has approved or corrected on a call) and, when it is clearly the
 * same person, saved with the known spelling and organisation.
 */

export type KnownName = { name: string; organisation: string | null };

const TITLES = new Set([
  'dr',
  'doctor',
  'prof',
  'professor',
  'mr',
  'mrs',
  'ms',
  'miss',
  'mister',
  'engr',
  'engineer',
  'hon',
  'honourable',
  'honorable',
  'barr',
  'barrister',
  'sir',
  'madam',
  'chief',
  'alhaji',
  'alhaja',
  'rev',
  'pastor',
]);

/** The words of a name that identify the person: lower case, no accents or titles. */
export function nameWords(name: string): string[] {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 1 && !TITLES.has(w));
}

function distance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/** A surname heard slightly wrong: one letter off in a short name, two from eight letters. */
const closeSurname = (a: string, b: string) =>
  a === b ||
  (Math.min(a.length, b.length) >= 5 &&
    distance(a, b) <= (Math.max(a.length, b.length) >= 8 ? 2 : 1));

/** A first name shortened ("Chris", "Christopher") or one letter off. */
const closeFirst = (a: string, b: string) =>
  a === b ||
  (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a))) ||
  (Math.min(a.length, b.length) >= 5 && distance(a, b) <= 1);

/**
 * Whether two names are clearly one person: first and last names both match,
 * allowing a shortened first name and a misheard surname. A single name
 * ("Chris") matches only the same single name, as there may be several.
 */
export function samePerson(a: string, b: string): boolean {
  const x = nameWords(a);
  const y = nameWords(b);
  if (!x.length || !y.length) return false;
  if (x.length === 1 || y.length === 1)
    return x.length === y.length && x[0] === y[0];
  return closeFirst(x[0], y[0]) && closeSurname(x.at(-1)!, y.at(-1)!);
}

/**
 * The known spelling of a name, when exactly one known person matches it;
 * else null. `known` comes in order of trust: the first match wins ties of
 * the same person spelled two ways.
 */
export function snapName(
  name: string | null | undefined,
  known: KnownName[],
): KnownName | null {
  if (!name?.trim()) return null;
  const matches = known.filter((k) => samePerson(name, k.name));
  if (!matches.length) return null;
  // two different people fit (e.g. two "Chris A…"s): leave the name as found
  const first = matches[0];
  if (matches.some((m) => !samePerson(m.name, first.name))) return null;
  return {
    name: first.name,
    organisation:
      first.organisation ??
      matches.find((m) => m.organisation)?.organisation ??
      null,
  };
}

/** A found name and organisation, spelled as known when it is clearly a known person. */
export function spellAsKnown(
  name: string | null,
  organisation: string | null,
  known: KnownName[],
): { name: string | null; organisation: string | null } {
  const snapped = snapName(name, known);
  if (!snapped) return { name, organisation };
  return {
    name: snapped.name,
    organisation: snapped.organisation ?? organisation,
  };
}
