import {
  cleanDesign,
  cleanSvg,
  hex,
  type DeckDesignAnswer,
} from './deck-design';
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

const ART =
  '<svg viewBox="0 0 1600 900" width="10"><defs><linearGradient id="g"><stop offset="0" stop-color="#0e7c7b"/></linearGradient></defs><path d="M0 0h1600v900H0z" fill="url(#g)"/></svg>';

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
  art: {
    cover: ART,
    content: '<svg viewBox="0 0 1600 900"><script>alert(1)</script></svg>',
    closing: 'not svg',
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

  it('keeps artwork PowerPoint can draw, and nothing that could run or reach out', () => {
    const design = cleanDesign(answer(), ['c1'], null);
    expect(design.art.cover).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(design.art.cover).toContain('width="1600" height="900"');
    expect(design.art.cover).not.toContain('width="10"');
    expect(design.art.content).toBeNull(); // a script
    expect(design.art.closing).toBeNull(); // not SVG
    expect(
      cleanSvg(
        '<svg viewBox="0 0 1600 900"><image href="https://x/y.png"/></svg>',
      ),
    ).toBeNull();
    expect(
      cleanSvg('<svg viewBox="0 0 1600 900"><rect onclick="x()"/></svg>'),
    ).toBeNull();
    expect(
      cleanSvg(
        '<svg viewBox="0 0 1600 900"><rect fill="url(https://x)"/></svg>',
      ),
    ).toBeNull();
    expect(cleanSvg('<svg viewBox="0 0 800 600"><rect/></svg>')).toBeNull(); // wrong canvas
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
