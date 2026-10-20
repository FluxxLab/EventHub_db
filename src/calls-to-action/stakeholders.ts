/**
 * Stakeholders: the organisations the event's delegates belong to, matched to
 * the calls to action. A recommendation aimed at an organisation is something
 * it is asked to commit to; a pledge made by or for it is a commitment. The
 * asks with no commitment yet are the follow-up list, with the delegates from
 * that organisation who are at the event to approach.
 *
 * Organisation names are matched loosely, because delegates type them
 * however they like and speakers say them however they like: case, accents,
 * punctuation and "the"/"of"/"and" do not matter, an abbreviation in brackets
 * stands for the name ("National Information Technology Development Agency
 * (NITDA)" is "NITDA"), and so do a long name's initials.
 *
 * Pure: the service reads the rows and hands them in.
 */

const STOP = new Set([
  'the',
  'of',
  'and',
  'for',
  'in',
  'on',
  'at',
  'to',
  'a',
  'an',
]);

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);

type Aliases = { literal: Set<string>; initials: string | null };

/** The keys an organisation's name goes by. */
export function orgAliases(name: string): Aliases {
  const literal = new Set<string>();
  const bare = name.replace(/\([^)]*\)/g, ' ');
  const key = (s: string) =>
    words(s)
      .filter((w) => !STOP.has(w))
      .join('');
  for (const k of [key(name), key(bare)]) if (k) literal.add(k);
  for (const m of name.matchAll(/\(([^)]+)\)/g)) {
    const k = key(m[1]);
    if (k) literal.add(k);
  }
  const significant = words(bare).filter((w) => !STOP.has(w));
  const initials =
    significant.length >= 3 ? significant.map((w) => w[0]).join('') : null;
  return { literal, initials };
}

/**
 * Whether two names are one organisation: a key in common, or one's initials
 * written out as the other ("NITDA"). Two sets of initials alone must agree on
 * four letters or more, since short ones collide.
 */
export function sameOrg(a: Aliases, b: Aliases): boolean {
  for (const k of a.literal) if (b.literal.has(k)) return true;
  if (a.initials && b.literal.has(a.initials)) return true;
  if (b.initials && a.literal.has(b.initials)) return true;
  return !!a.initials && a.initials.length >= 4 && a.initials === b.initials;
}

/**
 * The parts of a call's target that could each be an organisation: the whole
 * of it, and its pieces split at commas, slashes and " and " ("NITDA and
 * NCAIR"). The whole is tried too, since names contain "and".
 */
function targetParts(target: string): Aliases[] {
  const parts = [target, ...target.split(/\s*(?:,|;|\/|\band\b|&)\s*/i)];
  return [...new Set(parts.map((p) => p.trim()).filter(Boolean))].map(
    orgAliases,
  );
}

export type StakeholderDelegate = {
  id: string;
  name: string;
  title: string | null;
  email: string;
  organisation: string;
  /** Checked in at the door for this event. */
  admitted: boolean;
};

/** Someone on the programme, with the organisation the programme gives them. */
export type StakeholderSpeaker = {
  id: string;
  name: string;
  role: string | null;
  organisation: string;
};

export type StakeholderCall = {
  id: string;
  type: 'recommendation' | 'pledge';
  directedAt: string;
  proposedByOrganisation: string | null;
  status: string;
};

export type Stakeholder = {
  /** The spelling most of its people use. */
  name: string;
  /** Every spelling its delegates and speakers used. */
  spellings: string[];
  delegates: Omit<StakeholderDelegate, 'organisation'>[];
  /** Its people on the programme (who may also hold tickets). */
  speakers: Omit<StakeholderSpeaker, 'organisation'>[];
  /** Recommendations aimed at it: what it is asked to commit to. */
  asks: string[];
  /** Pledges by or for it. */
  commitments: string[];
};

/** A broad target tied to one of the event's organisations (see StakeholderLink). */
export type StakeholderLinkView = {
  id: string;
  target: string;
  organisation: string;
  status: 'suggested' | 'confirmed' | 'rejected';
  reason: string | null;
};

export type StakeholderMap = {
  stakeholders: Stakeholder[];
  /** For each call, the organisations at the event it concerns. */
  byCall: Record<string, string[]>;
  /** Recommendation targets that match no organisation at the event, with how many calls name each. */
  unmatched: { target: string; calls: number }[];
  /** Links suggested and confirmed (rejected ones are not shown again). */
  links: StakeholderLinkView[];
};

const targetKey = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

const tidyOrg = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * The event's organisations, grouped from the spellings of its delegates and
 * speakers, each with the calls aimed at it and the commitments made by or for
 * it. Rejected and merged calls are left out.
 */
export function mapStakeholders(
  delegates: StakeholderDelegate[],
  calls: StakeholderCall[],
  links: StakeholderLinkView[] = [],
  speakers: StakeholderSpeaker[] = [],
): StakeholderMap {
  // one organisation per group of spellings that match each other
  const spellings = new Map<string, number>();
  for (const p of [...delegates, ...speakers]) {
    const name = tidyOrg(p.organisation);
    if (name) spellings.set(name, (spellings.get(name) ?? 0) + 1);
  }
  const names = [...spellings.keys()];
  const aliases = names.map(orgAliases);
  const parent = names.map((_, i) => i);
  const root = (i: number): number =>
    parent[i] === i ? i : (parent[i] = root(parent[i]));
  for (let i = 0; i < names.length; i += 1)
    for (let j = i + 1; j < names.length; j += 1)
      if (sameOrg(aliases[i], aliases[j])) parent[root(j)] = root(i);

  const groups = new Map<number, number[]>();
  names.forEach((_, i) =>
    groups.set(root(i), [...(groups.get(root(i)) ?? []), i]),
  );
  const orgs = [...groups.values()].map((members) => {
    const sorted = [...members].sort(
      (a, b) =>
        spellings.get(names[b])! - spellings.get(names[a])! ||
        names[b].length - names[a].length,
    );
    return {
      name: names[sorted[0]],
      spellings: sorted.map((i) => names[i]),
      aliases: members.map((i) => aliases[i]),
    };
  });
  const orgOf = new Map<string, string>();
  for (const o of orgs) for (const s of o.spellings) orgOf.set(s, o.name);

  // a broad target's confirmed organisations, by the target's key
  const linked = new Map<string, Aliases[]>();
  for (const l of links) {
    if (l.status !== 'confirmed') continue;
    const key = targetKey(l.target);
    linked.set(key, [...(linked.get(key) ?? []), orgAliases(l.organisation)]);
  }
  const matches = (text: string | null) => {
    if (!text?.trim()) return [];
    const parts = targetParts(text);
    const via = linked.get(targetKey(text)) ?? [];
    return orgs
      .filter((o) =>
        o.aliases.some(
          (a) =>
            parts.some((p) => sameOrg(a, p)) || via.some((v) => sameOrg(a, v)),
        ),
      )
      .map((o) => o.name);
  };

  const asks = new Map<string, string[]>();
  const commitments = new Map<string, string[]>();
  const byCall: Record<string, string[]> = {};
  const unmatched = new Map<string, { target: string; calls: number }>();
  for (const c of calls) {
    if (c.status === 'rejected' || c.status === 'merged') continue;
    const hit =
      c.type === 'pledge'
        ? [
            ...new Set([
              ...matches(c.directedAt),
              ...matches(c.proposedByOrganisation),
            ]),
          ]
        : matches(c.directedAt);
    byCall[c.id] = hit;
    const into = c.type === 'pledge' ? commitments : asks;
    for (const org of hit) into.set(org, [...(into.get(org) ?? []), c.id]);
    if (c.type === 'recommendation' && hit.length === 0) {
      const key = targetKey(c.directedAt);
      const was = unmatched.get(key);
      unmatched.set(key, {
        target: was?.target ?? c.directedAt.trim(),
        calls: (was?.calls ?? 0) + 1,
      });
    }
  }

  const stakeholders = orgs
    .map((o) => ({
      name: o.name,
      spellings: o.spellings,
      delegates: delegates
        .filter((d) => orgOf.get(tidyOrg(d.organisation)) === o.name)
        .map((d) => ({
          id: d.id,
          name: d.name,
          title: d.title,
          email: d.email,
          admitted: d.admitted,
        }))
        .sort(
          (a, b) =>
            Number(b.admitted) - Number(a.admitted) ||
            a.name.localeCompare(b.name),
        ),
      speakers: speakers
        .filter((s) => orgOf.get(tidyOrg(s.organisation)) === o.name)
        .map((s) => ({ id: s.id, name: s.name, role: s.role }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      asks: asks.get(o.name) ?? [],
      commitments: commitments.get(o.name) ?? [],
    }))
    .sort(
      (a, b) =>
        b.asks.length - a.asks.length ||
        b.commitments.length - a.commitments.length ||
        a.name.localeCompare(b.name),
    );

  return {
    stakeholders,
    byCall,
    unmatched: [...unmatched.values()].sort((a, b) => b.calls - a.calls),
    links: links.filter((l) => l.status !== 'rejected'),
  };
}

/** "NITDA" from "National Information Technology Development Agency (NITDA)"; a name with no abbreviation as it is. */
export function shortOrg(name: string): string {
  const abbr = name.match(/\(([A-Za-z][A-Za-z&.-]{1,11})\)\s*$/);
  return abbr ? abbr[1] : name.trim();
}

/** "3 delegates, 1 speaker": how many of an organisation's people are at the event. */
export function peopleCount(
  s: Pick<Stakeholder, 'delegates' | 'speakers'>,
): string {
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? '' : 's'}`;
  return [
    s.delegates.length ? n(s.delegates.length, 'delegate') : null,
    s.speakers.length ? n(s.speakers.length, 'speaker') : null,
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * The organisations a call concerns that have people at the event, as one
 * line for a deck or report: "NITDA (3 delegates, 1 speaker); World Bank (1
 * delegate)". Two at most, then "and 2 more". Never names anyone. Null when
 * none.
 */
export function presentLine(
  map: StakeholderMap,
  callId: string,
): string | null {
  const people = (s: Stakeholder) => s.delegates.length + s.speakers.length;
  const orgs = (map.byCall[callId] ?? [])
    .map((name) => map.stakeholders.find((s) => s.name === name))
    .filter((s): s is Stakeholder => !!s && people(s) > 0)
    .sort((a, b) => people(b) - people(a));
  if (!orgs.length) return null;
  const shown = orgs
    .slice(0, 2)
    .map((s) => `${shortOrg(s.name)} (${peopleCount(s)})`);
  const more = orgs.length - shown.length;
  return `${shown.join('; ')}${more ? ` and ${more} more` : ''}`;
}
