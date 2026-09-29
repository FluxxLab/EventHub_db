import { deflateSync } from 'node:zlib';
import {
  codePrefix,
  fontName,
  layoutText,
  pageSize,
  renderTemplatedCertificate,
  type CertificateTemplate,
  type TextPlacement,
} from './certificate-template';

const page = { width: 841.89, height: 595.28 };
const placement = (over: Partial<TextPlacement> = {}): TextPlacement => ({
  x: 0.5,
  y: 0.5,
  size: 0.06,
  maxWidth: 0.6,
  color: '#002d74',
  font: 'serif',
  bold: false,
  align: 'center',
  ...over,
});
/** A stand-in for pdfkit's measure: 0.5 of the font size per character. */
const measure = (text: string, _font: string, size: number) =>
  text.length * size * 0.5;

/** A minimal valid PNG (one white pixel stretched to w x h is enough for pdfkit). */
function png(width: number, height: number): Buffer {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const byte of buf) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 255)]);
  const pixels = deflateSync(
    Buffer.concat(Array.from({ length: height }, () => row)),
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', pixels),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('certificate template', () => {
  it('turns the page to match the artwork', () => {
    expect(pageSize({ width: 3508, height: 2480 })).toEqual({
      width: 841.89,
      height: 595.28,
    });
    expect(pageSize({ width: 2480, height: 3508 })).toEqual({
      width: 595.28,
      height: 841.89,
    });
  });

  it('uses the built-in fonts', () => {
    expect(fontName({ font: 'serif', bold: true })).toBe('Times-Bold');
    expect(fontName({ font: 'sans', bold: false })).toBe('Helvetica');
  });

  it('centres a name on its point and keeps the size when it fits', () => {
    const box = layoutText(placement(), page, 'Ada Eze', measure);
    const width = 0.6 * page.width;
    expect(box.left).toBeCloseTo(page.width / 2 - width / 2);
    expect(box.width).toBeCloseTo(width);
    expect(box.fontSize).toBeCloseTo(0.06 * page.height);
    expect(box.font).toBe('Times-Roman');
  });

  it('shrinks a long name until it fits its box', () => {
    const long = 'Adaeze Chiamaka Nwachukwu-Okonkwo-Abubakar';
    const box = layoutText(placement(), page, long, measure);
    expect(box.fontSize).toBeLessThan(0.06 * page.height);
    expect(measure(long, box.font, box.fontSize)).toBeLessThanOrEqual(
      box.width,
    );
  });

  it('anchors left and right aligned text at its edge', () => {
    expect(
      layoutText(placement({ align: 'left', x: 0.1 }), page, 'x', measure).left,
    ).toBeCloseTo(0.1 * page.width);
    const right = layoutText(
      placement({ align: 'right', x: 0.9 }),
      page,
      'x',
      measure,
    );
    expect(right.left + right.width).toBeCloseTo(0.9 * page.width);
  });

  it('prefixes codes with the summit', () => {
    expect(codePrefix('GS-27')).toBe('GS27');
    expect(codePrefix('')).toBe('PIC');
    expect(codePrefix(null)).toBe('PIC');
  });

  it('renders a real PDF from the artwork', async () => {
    const template: CertificateTemplate = {
      key: 'certificates/00000000-0000-0000-0000-000000000000',
      contentType: 'image/png',
      width: 297,
      height: 210,
      name: placement(),
      code: placement({ y: 0.9, size: 0.02, font: 'sans' }),
      updatedAt: new Date().toISOString(),
    };
    const pdf = await renderTemplatedCertificate(template, png(297, 210), {
      name: 'Ngozi Eze',
      code: 'GS27-K7M2P-X4QRT',
      title: 'GS-27 certificate',
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(500);
  });
});
