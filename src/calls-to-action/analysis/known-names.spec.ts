import { samePerson, snapName, spellAsKnown } from './known-names';

describe('known names', () => {
  const known = [
    { name: 'Christopher Agbajogu', organisation: 'Fluxx Eco' },
    { name: 'Ibrahim Muhammad', organisation: 'Vision Tech Labs' },
    { name: 'Olashupo Ajala', organisation: null },
  ];

  it('treats a shortened first name and a misheard surname as the same person', () => {
    expect(samePerson('Chris Agbajogo', 'Christopher Agbajogu')).toBe(true);
    expect(samePerson('Dr. Chris Agbajogu', 'Christopher Agbajogu')).toBe(true);
    expect(samePerson('Ibrahim Mohammed', 'Ibrahim Muhammad')).toBe(true);
  });

  it('keeps different people apart', () => {
    expect(samePerson('Chris Ibrahim', 'Christopher Agbajogu')).toBe(false);
    expect(samePerson('Chris', 'Christopher Agbajogu')).toBe(false);
    expect(samePerson('Grace Obi', 'Grace Oba')).toBe(false); // short surnames must match exactly
    expect(samePerson('John Okafor', 'Joan Okafor')).toBe(false);
  });

  it('spells a found name the known way, with the known organisation', () => {
    expect(snapName('Chris Agbajogo', known)).toEqual({
      name: 'Christopher Agbajogu',
      organisation: 'Fluxx Eco',
    });
    expect(spellAsKnown('Chris Agbajogo', 'Flux Echo', known)).toEqual({
      name: 'Christopher Agbajogu',
      organisation: 'Fluxx Eco',
    });
  });

  it('keeps the found organisation when the known name has none', () => {
    expect(spellAsKnown('Olashupo Ajala', 'NCAIR', known)).toEqual({
      name: 'Olashupo Ajala',
      organisation: 'NCAIR',
    });
  });

  it('leaves unknown and ambiguous names as found', () => {
    expect(spellAsKnown('Ada Lovelace', null, known)).toEqual({
      name: 'Ada Lovelace',
      organisation: null,
    });
    expect(
      snapName('Chris Agbaje', [
        { name: 'Christopher Agbaje', organisation: null },
        { name: 'Christiana Agbajo', organisation: null },
      ]),
    ).toBeNull();
    expect(snapName(null, known)).toBeNull();
  });
});
