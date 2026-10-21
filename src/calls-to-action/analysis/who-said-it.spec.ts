import { cleanWho, nameIsGrounded, type WhoAnswer } from './who-said-it';
import type { AnalysisLine } from './analysis.provider';

const at = new Date('2026-10-21T10:51:00Z');
const lines: AnalysisLine[] = [
  {
    n: 1,
    at,
    who: 'Speaker 2',
    text: 'Please welcome doctor Olubunmi Ajala, representing the honourable minister.',
  },
  {
    n: 2,
    at,
    who: 'Speaker 3',
    text: 'We are going to build a data park in Egbe for Nigeria and Togo.',
  },
];
const speakers = ['Melanie Hui (Luminate)'];

const answer = (name: string | null, confidence = 0.9): WhoAnswer => ({
  items: [
    {
      ref: 'C1',
      name,
      organisation: 'NCAIR',
      evidence: 'Please welcome doctor Olubunmi Ajala',
      confidence,
    },
  ],
});

describe('who said it', () => {
  it('keeps a name heard in the transcript or on the programme', () => {
    expect(nameIsGrounded('Dr. Olubunmi Ajala', lines, speakers)).toBe(true);
    expect(nameIsGrounded('Melanie Hui', lines, speakers)).toBe(true);
    expect(
      cleanWho(
        answer('Dr. Olubunmi Ajala'),
        new Set(['C1']),
        lines,
        speakers,
      ).get('C1'),
    ).toEqual({
      name: 'Dr. Olubunmi Ajala',
      organisation: 'NCAIR',
    });
  });

  it('drops an invented name, a voice label, a weak guess or an unknown ref', () => {
    expect(nameIsGrounded('Dr. Ngozi Okonjo', lines, speakers)).toBe(false);
    expect(
      cleanWho(answer('Dr. Ngozi Okonjo'), new Set(['C1']), lines, speakers)
        .size,
    ).toBe(0);
    expect(
      cleanWho(answer('Speaker 3'), new Set(['C1']), lines, speakers).size,
    ).toBe(0);
    expect(
      cleanWho(
        answer('Dr. Olubunmi Ajala', 0.4),
        new Set(['C1']),
        lines,
        speakers,
      ).size,
    ).toBe(0);
    expect(
      cleanWho(answer('Dr. Olubunmi Ajala'), new Set(['C2']), lines, speakers)
        .size,
    ).toBe(0);
    expect(cleanWho(answer(null), new Set(['C1']), lines, speakers).size).toBe(
      0,
    );
  });

  it('does not count a title alone', () => {
    expect(nameIsGrounded('Doctor', lines, speakers)).toBe(false);
  });
});
