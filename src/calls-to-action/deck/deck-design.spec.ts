import { cleanDesign, hex, type DeckDesignAnswer } from './deck-design';
import { deckDates } from '../calls-to-action.service';

const shape = (
  over: Partial<DeckDesignAnswer['decor']['cover'][number]> = {},
) => ({
  kind: 'ellipse' as const,
  x: 1,
  y: 1,
  w: 2,
  h: 2,
  colour: 'primary' as const,
  rotate: 0,
  flipH: false,
  flipV: false,
  transparency: 0,
  ...over,
});

const answer = (over: Partial<DeckDesignAnswer> = {}): DeckDesignAnswer => ({
  rationale: 'Rings from the logo, on a pale teal.',
  palette: {
    primary: '#0E7C7B',
    secondary: '#f2a900',
    accent: 'tomato',
    background: '#ffffff',
    surface: '#ffffff',
    text: '#102a2a',
    muted: '#4f6464',
  },
  headingFont: 'Georgia',
  bodyFont: 'Calibri',
  uppercaseTitles: false,
  deckTitle: 'Calls to Action',
  deckSubtitle: 'What the summit asked, and of whom',
  layouts: {
    cover: 'split',
    summary: 'statement',
    section: 'list',
    closing: 'band',
  },
  decor: {
    cover: [shape()],
    content: [shape({ x: 99, w: -3, transparency: 400 })],
    closing: [],
  },
  summary: {
    headline: 'Five asks, three institutions',
    points: ['a', 'b', 'c', 'd', 'e'],
  },
  sections: [
    { title: 'Finance', intro: null, callIds: ['c1', 'c2', 'nope', 'c1'] },
    { title: 'Empty', intro: 'Nothing here', callIds: ['zzz'] },
  ],
  nextSteps: [{ lead: 'Confirm', rest: 'each call' }],
  ...over,
});

/** Claude's deck design, made safe to draw. */
describe('deck design', () => {
  it('places every approved call once: unknown ids dropped, missing ones gathered at the end', () => {
    const design = cleanDesign(answer(), ['c1', 'c2', 'c3'], '#0e7c7b');
    expect(design.sections).toEqual([
      { title: 'Finance', intro: null, callIds: ['c1', 'c2'] },
      { title: 'More calls to action', intro: null, callIds: ['c3'] },
    ]);
  });

  it('keeps colours it can read and replaces the rest', () => {
    const design = cleanDesign(answer(), ['c1'], '#0e7c7b');
    expect(design.palette.primary).toBe('#0e7c7b');
    expect(design.palette.accent).toBe('#f5c400'); // "tomato" is not a hex colour
    expect(hex('ABCDEF')).toBe('#abcdef');
    expect(hex('#abc')).toBeNull();
  });

  it('keeps shapes near the canvas and the summary to four points', () => {
    const design = cleanDesign(answer(), ['c1'], null);
    expect(design.decor.content[0]).toMatchObject({
      x: 11,
      w: 0.1,
      transparency: 90,
    });
    expect(design.summary.points).toHaveLength(4);
  });

  it('writes the dates as the cover shows them', () => {
    expect(
      deckDates(
        new Date('2026-09-08T08:00:00Z'),
        new Date('2026-09-09T17:00:00Z'),
      ),
    ).toBe('8 – 9 Sept 2026');
    expect(
      deckDates(
        new Date('2026-09-30T08:00:00Z'),
        new Date('2026-10-01T17:00:00Z'),
      ),
    ).toBe('30 Sept – 1 Oct 2026');
  });
});
