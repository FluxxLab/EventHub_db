import { BASE_TERMS, captionTerms, MAX_TERMS } from './caption-terms';

/** What a session's captions listen for: the organisers' words, the event, and who is on stage. */
describe('caption terms', () => {
  it("puts the organisers' words first, then the event and its speakers, each once", () => {
    expect(
      captionTerms({
        vocabulary: ['full product', '  FMWASD ', 'Full Product'],
        event: { name: 'Build Conference 2026', shortName: 'Build2026' },
        speakers: [
          { name: 'Dr Amina Bello', organisation: 'NBS' },
          { name: 'Kwame Mensah', organisation: 'NBS' },
          { name: null, organisation: null },
        ],
      }),
    ).toEqual([
      'full product',
      'FMWASD',
      'Build Conference 2026',
      'Build2026',
      'Dr Amina Bello',
      'NBS',
      'Kwame Mensah',
      ...BASE_TERMS,
    ]);
  });

  it('leaves out sentences and keeps within what Deepgram takes', () => {
    const many = Array.from({ length: 150 }, (_, i) => `term ${i}`);
    const terms = captionTerms({ vocabulary: [...many, 'x'.repeat(61)] });
    expect(terms).toHaveLength(MAX_TERMS);
    expect(terms[0]).toBe('term 0');
    expect(terms.some((t) => t.length > 60)).toBe(false);
  });

  it('still listens for the base terms with nothing else known', () => {
    expect(captionTerms({})).toEqual(BASE_TERMS);
  });
});
