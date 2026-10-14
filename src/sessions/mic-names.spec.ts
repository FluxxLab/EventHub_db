import { micNames } from './mic-names';

/** A caption's mic, named from the session: its speaker, else the mic's label. */
describe('mic names', () => {
  const speakers = [
    { id: 'a', name: 'Dr Amina Bello' },
    { id: 'k', name: 'Kwame Mensah' },
  ];

  it('names each mic by its speaker, else its label, and leaves the rest out', () => {
    const names = micNames({
      speakers: speakers as never,
      mics: [
        { mic: 1, speakerId: 'a', label: null },
        { mic: 2, speakerId: null, label: 'Audience' },
        // a speaker since taken off the session: nobody to name
        { mic: 3, speakerId: 'gone', label: null },
      ],
    });
    expect([...names]).toEqual([
      [1, 'Dr Amina Bello'],
      [2, 'Audience'],
    ]);
  });

  it('is empty for a session whose mics were never named', () => {
    expect(micNames({ speakers: [], mics: [] }).size).toBe(0);
    expect(micNames({} as never).size).toBe(0);
  });
});
