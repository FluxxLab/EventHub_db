import PDFDocument from 'pdfkit';

/**
 * An edition's certificate design: artwork the organisers upload (PNG or JPG),
 * and where the delegate's name and the verification code go on it.
 *
 * Positions and sizes are fractions of the page (0 to 1), not points or
 * pixels, so the same placement holds whatever resolution the artwork was
 * exported at and however the console previews it.
 */
export type CertificateFont = 'sans' | 'serif';
export type CertificateAlign = 'left' | 'center' | 'right';

export interface TextPlacement {
  /** The alignment point across the page: the left edge, centre or right edge of the text. */
  x: number;
  /** The vertical centre of the line, down the page. */
  y: number;
  /** Font size as a fraction of the page height. */
  size: number;
  /** The widest the text may run, as a fraction of the page width; longer names shrink to fit. */
  maxWidth: number;
  color: string;
  font: CertificateFont;
  bold: boolean;
  align: CertificateAlign;
}

export interface CertificateTemplate {
  /** Storage key of the artwork (under certificates/). */
  key: string;
  contentType: 'image/png' | 'image/jpeg';
  /** The artwork's size in pixels: its shape decides landscape or portrait. */
  width: number;
  height: number;
  name: TextPlacement;
  /** Where the verification code goes, or null to leave it off the artwork. */
  code: TextPlacement | null;
  updatedAt: string;
}

/** A4 in points, turned to match the artwork. */
export function pageSize(t: Pick<CertificateTemplate, 'width' | 'height'>): {
  width: number;
  height: number;
} {
  return t.width >= t.height
    ? { width: 841.89, height: 595.28 }
    : { width: 595.28, height: 841.89 };
}

/** pdfkit's built-in fonts: no font files to ship, and every PDF reader has them. */
export function fontName(p: Pick<TextPlacement, 'font' | 'bold'>): string {
  if (p.font === 'serif') return p.bold ? 'Times-Bold' : 'Times-Roman';
  return p.bold ? 'Helvetica-Bold' : 'Helvetica';
}

export interface TextBox {
  left: number;
  top: number;
  width: number;
  fontSize: number;
  font: string;
  align: CertificateAlign;
}

/** The smallest a name is shrunk to before it is allowed to wrap. */
const MIN_FONT_SIZE = 8;

/**
 * Where one line of text lands on the page. A name wider than its box shrinks
 * in 5% steps until it fits, so "Adaeze Nwachukwu-Okonkwo" and "Ada Eze" both
 * sit on the same line of the design.
 */
export function layoutText(
  p: TextPlacement,
  page: { width: number; height: number },
  text: string,
  measure: (text: string, font: string, size: number) => number,
): TextBox {
  const font = fontName(p);
  const width = p.maxWidth * page.width;
  let fontSize = p.size * page.height;
  while (fontSize > MIN_FONT_SIZE && measure(text, font, fontSize) > width) {
    fontSize *= 0.95;
  }
  const anchor = p.x * page.width;
  const left =
    p.align === 'center'
      ? anchor - width / 2
      : p.align === 'right'
        ? anchor - width
        : anchor;
  // pdfkit places text by the top of the line; centre it on y instead.
  const top = p.y * page.height - fontSize * 0.6;
  return { left, top, width, fontSize, font, align: p.align };
}

/** Renders one certificate: the artwork as the page, the name and code on top. */
export function renderTemplatedCertificate(
  template: CertificateTemplate,
  artwork: Buffer,
  text: { name: string; code: string; title: string },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const page = pageSize(template);
    const doc = new PDFDocument({
      size: [page.width, page.height],
      margin: 0,
      info: { Title: text.title, Author: 'Policy Innovation Centre' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      doc.image(artwork, 0, 0, { width: page.width, height: page.height });
      const measure = (s: string, font: string, size: number) =>
        doc.font(font).fontSize(size).widthOfString(s);
      const draw = (p: TextPlacement, value: string) => {
        const box = layoutText(p, page, value, measure);
        doc
          .font(box.font)
          .fontSize(box.fontSize)
          .fillColor(p.color)
          .text(value, box.left, box.top, {
            width: box.width,
            align: box.align,
            lineBreak: false,
          });
      };
      draw(template.name, text.name);
      if (template.code) draw(template.code, text.code);
      doc.end();
    } catch (error) {
      reject(error as Error);
    }
  });
}

/**
 * The prefix on an edition's certificate codes, from its short name: "GS-27"
 * gives GS27-K7M2P-X4QRT, so a code says which summit it is for.
 */
export function codePrefix(shortName: string | null | undefined): string {
  const cleaned = (shortName ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return cleaned.slice(0, 8) || 'PIC';
}
