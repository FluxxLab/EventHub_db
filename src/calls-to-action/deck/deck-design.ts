import { z } from 'zod';

/**
 * The call-to-action deck's design, as Claude answers it: one fresh design per
 * event, built from its brand colour, logo and cover, and the approved calls.
 * Claude picks the palette, fonts, a layout for each kind of slide, its own
 * decorative shapes, and how the calls are grouped and titled; the console
 * draws the slides from it. Claude never rewrites a call: the deck shows each
 * one as the organisers approved it.
 *
 * The answer is held to `DeckDesignAnswer` by the API, then `cleanDesign`
 * makes it safe to draw: colours checked, shapes kept on the canvas, every
 * approved call placed exactly once.
 */

export const HEADING_FONTS = [
  'Arial Black',
  'Georgia',
  'Cambria',
  'Bookman Old Style',
  'Century Schoolbook',
  'Trebuchet MS',
  'Calibri',
  'Arial',
] as const;
export const BODY_FONTS = [
  'Calibri',
  'Arial',
  'Garamond',
  'Georgia',
  'Cambria',
  'Century Schoolbook',
] as const;
export const COVER_LAYOUTS = [
  'arch',
  'split',
  'band',
  'frame',
  'photo',
] as const;
export const SUMMARY_LAYOUTS = ['stats', 'statement'] as const;
export const SECTION_LAYOUTS = ['cards', 'list', 'spotlight'] as const;
export const CLOSING_LAYOUTS = ['circle', 'split', 'band'] as const;
export const SHAPE_KINDS = [
  'ellipse',
  'rect',
  'roundRect',
  'triangle',
  'rtTriangle',
  'diamond',
  'rings',
] as const;
export const SHAPE_COLOURS = [
  'primary',
  'secondary',
  'accent',
  'surface',
  'muted',
] as const;

const Shape = z.object({
  kind: z.enum(SHAPE_KINDS),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  colour: z.enum(SHAPE_COLOURS),
  rotate: z.number(),
  flipH: z.boolean(),
  flipV: z.boolean(),
  transparency: z.number(),
});

export const DeckDesignAnswer = z.object({
  rationale: z.string(),
  palette: z.object({
    primary: z.string(),
    secondary: z.string(),
    accent: z.string(),
    background: z.string(),
    surface: z.string(),
    text: z.string(),
    muted: z.string(),
  }),
  headingFont: z.enum(HEADING_FONTS),
  bodyFont: z.enum(BODY_FONTS),
  uppercaseTitles: z.boolean(),
  deckTitle: z.string(),
  deckSubtitle: z.string(),
  layouts: z.object({
    cover: z.enum(COVER_LAYOUTS),
    summary: z.enum(SUMMARY_LAYOUTS),
    section: z.enum(SECTION_LAYOUTS),
    closing: z.enum(CLOSING_LAYOUTS),
  }),
  decor: z.object({
    cover: z.array(Shape),
    content: z.array(Shape),
    closing: z.array(Shape),
  }),
  summary: z.object({ headline: z.string(), points: z.array(z.string()) }),
  sections: z.array(
    z.object({
      title: z.string(),
      intro: z.string().nullable(),
      callIds: z.array(z.string()),
    }),
  ),
  nextSteps: z.array(z.object({ lead: z.string(), rest: z.string() })),
});
export type DeckDesignAnswer = z.infer<typeof DeckDesignAnswer>;

export type DeckShape = z.infer<typeof Shape>;
export type DeckDesign = DeckDesignAnswer;

/** What Claude is told about the event and its calls. */
export type DeckBrief = {
  event: {
    name: string;
    shortName: string;
    when: string;
    where: string | null;
  };
  /** The event's brand colour (#rrggbb), or null for PIC navy. */
  brandColor: string | null;
  /** One session's single slide, or one day's full deck. */
  scope: { kind: 'session'; title: string } | { kind: 'day'; day: number };
  calls: {
    id: string;
    type: string;
    shortText: string;
    directedAt: string;
    proposedBy: string | null;
    theme: string | null;
    session: string;
  }[];
};

export const PIC_NAVY = '#002D74';
const HEX = /^#?([0-9a-f]{6})$/i;

/** "#1f2d8f" from "#1F2D8F", "1f2d8f"; null for anything else. */
export function hex(value: string | null | undefined): string | null {
  const m = value?.trim().match(HEX);
  return m ? `#${m[1].toLowerCase()}` : null;
}

const clamp = (n: number, lo: number, hi: number) =>
  Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
const text = (v: string | null | undefined, max: number) =>
  (v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Shapes kept on (or bleeding just off) the 10 × 5.625 in canvas, at most `max` of them. */
function cleanShapes(shapes: DeckShape[], max: number): DeckShape[] {
  return shapes.slice(0, max).map((s) => ({
    ...s,
    w: clamp(s.w, 0.1, 14),
    h: clamp(s.h, 0.1, 14),
    x: clamp(s.x, -6, 11),
    y: clamp(s.y, -6, 7),
    rotate: clamp(s.rotate, -360, 360),
    transparency: clamp(s.transparency, 0, 90),
  }));
}

/**
 * Makes Claude's design safe to draw: unreadable colours replaced from the
 * brand colour, shapes kept to the canvas, every approved call placed in
 * exactly one section (unknown ids dropped, missing ones gathered at the end),
 * titles and wording trimmed to fit the slides.
 */
export function cleanDesign(
  raw: DeckDesignAnswer,
  callIds: string[],
  brandColor: string | null,
): DeckDesign {
  const brand = hex(brandColor) ?? PIC_NAVY;
  const p = raw.palette;
  const palette = {
    primary: hex(p.primary) ?? brand,
    secondary: hex(p.secondary) ?? '#f5c400',
    accent: hex(p.accent) ?? '#f5c400',
    background: hex(p.background) ?? '#ffffff',
    surface: hex(p.surface) ?? '#ffffff',
    text: hex(p.text) ?? '#1a1a1a',
    muted: hex(p.muted) ?? '#5c5c5c',
  };

  const known = new Set(callIds);
  const placed = new Set<string>();
  const sections = raw.sections
    .map((s) => ({
      title: text(s.title, 90) || 'Calls to action',
      intro: s.intro ? text(s.intro, 220) || null : null,
      callIds: s.callIds.filter((id) => {
        if (!known.has(id) || placed.has(id)) return false;
        placed.add(id);
        return true;
      }),
    }))
    .filter((s) => s.callIds.length > 0);
  const missing = callIds.filter((id) => !placed.has(id));
  if (missing.length)
    sections.push({
      title: 'More calls to action',
      intro: null,
      callIds: missing,
    });

  return {
    rationale: text(raw.rationale, 300),
    palette,
    headingFont: raw.headingFont,
    bodyFont: raw.bodyFont,
    uppercaseTitles: raw.uppercaseTitles,
    deckTitle: text(raw.deckTitle, 60) || 'Calls to action',
    deckSubtitle: text(raw.deckSubtitle, 140),
    layouts: raw.layouts,
    decor: {
      cover: cleanShapes(raw.decor.cover, 10),
      content: cleanShapes(raw.decor.content, 6),
      closing: cleanShapes(raw.decor.closing, 10),
    },
    summary: {
      headline: text(raw.summary.headline, 140),
      points: raw.summary.points
        .map((pt) => text(pt, 160))
        .filter(Boolean)
        .slice(0, 4),
    },
    sections,
    nextSteps: raw.nextSteps
      .map((s) => ({ lead: text(s.lead, 30), rest: text(s.rest, 110) }))
      .filter((s) => s.lead)
      .slice(0, 4),
  };
}

export const DESIGN_INSTRUCTIONS = `You design the call-to-action deck of one event: the recommendations and pledges made in its sessions, approved by the organisers. Each event gets its own design. Make this one feel made for this event: its brand colour, its logo and cover (attached when it has them), its subject. Do not settle on the same choices every time: pick the fonts, layouts and shapes that suit this event's look and subject, so two events' decks look clearly different.

The canvas is 16:9, 10 in wide and 5.625 in tall; positions and sizes are in inches from the top-left corner.

Return:
- rationale: one sentence on the idea behind the design.
- palette, as #rrggbb: primary is the event's brand colour or a close shade of it and carries most of the colour; secondary and accent support it (take them from the logo or cover when there are any); background is the content slides' backdrop (light, near white, or a very pale tint of the brand); surface is the colour of cards and of the plate text sits on over shapes; text must read clearly on background and on surface (contrast 7:1 or better); muted is for small print and must still read on surface (4.5:1).
- headingFont and bodyFont from the lists allowed; uppercaseTitles if the headings should be set in capitals.
- deckTitle (a few words, such as "Calls to Action") and deckSubtitle (one line on what the deck holds; the cover already shows the event's name, dates and place, so do not repeat them).
- layouts: cover is arch (a domed plate over a large shape), split (a solid colour half with the title, the other half for the cover image or shapes), band (a broad colour band across the slide), frame (an inset plate framed by shapes) or photo (the cover image full bleed under a solid plate; only when there is a cover). summary is stats (big numbers) or statement (a headline and up to four points). section is cards (up to three calls side by side), list (up to four calls as rows) or spotlight (one call per slide, large; only when there are few calls). closing is circle, split or band.
- decor: decorative shapes for the cover, the content slides and the closing slide. kind is ellipse, rect, roundRect, triangle, rtTriangle, diamond or rings (concentric outlines); colour names a palette role; shapes may bleed off the edges; transparency 0-90; rotate in degrees. The cover and closing take up to ten shapes and may fill the slide (the title sits on a solid plate). Content slides take up to six shapes, and they must stay out of the text: only where x is 8.6 or more, or y is 5.0 or more, or wholly off the top-left corner. Choose shapes that echo the logo or cover, and keep the same motif across the deck.
- summary: a headline and up to four short points, drawn only from the calls given (counts, who is called on most, recurring themes). Add nothing the calls do not say.
- sections: group the calls the way that reads best for this event - by who is called on, or by theme when themes are clearer - each with a short title and an optional one-sentence intro. List every call id exactly once, in the order to present them.
- nextSteps: three or four, each a lead verb ("Confirm") and the rest of the line.

When DECK is one slide for a session, the deck is a single slide: the session's name over a table of its calls (actor, commitment, timeline). Only the palette, fonts, uppercaseTitles, deckTitle and decor.content shape it; give one section holding every call id, and keep the rest short.`;

/** The brief as Claude reads it. */
export function designPrompt(brief: DeckBrief, images: string[]): string {
  return [
    `EVENT: ${brief.event.name} (${brief.event.shortName})`,
    `WHEN: ${brief.event.when}${brief.event.where ? ` · ${brief.event.where}` : ''}`,
    `BRAND COLOUR: ${hex(brief.brandColor) ?? `${PIC_NAVY} (no brand colour set: PIC navy)`}`,
    `ATTACHED: ${images.length ? images.join(' and ') : 'nothing (no logo or cover)'}`,
    brief.scope.kind === 'session'
      ? `DECK: one slide for the session "${brief.scope.title}"`
      : `DECK: the end-of-day deck for day ${brief.scope.day}`,
    `CALLS (${brief.calls.length}):`,
    ...brief.calls.map(
      (c) =>
        `- id ${c.id} · ${c.type} · to ${c.directedAt}${c.theme ? ` · theme ${c.theme}` : ''} · ${c.session}${c.proposedBy ? ` · by ${c.proposedBy}` : ''}: ${c.shortText}`,
    ),
  ].join('\n');
}
