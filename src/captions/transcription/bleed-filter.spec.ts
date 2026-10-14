import { BleedFilter, overlap, wordsOf } from './bleed-filter';

/**
 * One voice reaching two mics: the lines from the 14 Oct test on a laptop's
 * two-mic array, where every phrase came through on both channels.
 */
describe('mic bleed', () => {
  let shown: string[];
  let clock: number;
  let filter: BleedFilter;
  const say = (text: string, channel: number, confidence: number) =>
    filter.push({
      text,
      channel,
      confidence,
      emit: () => shown.push(`${channel}:${text}`),
    });

  beforeEach(() => {
    jest.useFakeTimers();
    shown = [];
    clock = 0;
    filter = new BleedFilter(1000, 3000, 0.6, () => clock);
  });
  afterEach(() => jest.useRealTimers());
  const wait = (ms: number) => {
    clock += ms;
    jest.advanceTimersByTime(ms);
  };

  it('keeps the clearer of two mics hearing the same words', () => {
    say('So that would require', 2, 0.71);
    wait(200);
    say('that would require an extra panel slot', 1, 0.93);
    wait(1000);
    expect(shown).toEqual(['1:that would require an extra panel slot']);
  });

  it('drops an echo that arrives after its original was shown', () => {
    say('For the panel, if they speak in French', 1, 0.9);
    wait(1100);
    say('the panel if they speak in French', 2, 0.95);
    wait(1100);
    expect(shown).toEqual(['1:For the panel, if they speak in French']);
  });

  it('lets different speakers through, one after the other', () => {
    say('We call on banks to set aside lending for women', 1, 0.9);
    wait(300);
    say('The ministry will fund five hundred shelters', 2, 0.9);
    wait(1000);
    expect(shown).toEqual([
      '1:We call on banks to set aside lending for women',
      '2:The ministry will fund five hundred shelters',
    ]);
  });

  it('never treats a line on the same mic as an echo, nor two-word replies', () => {
    say('Okay so the next point is data', 1, 0.9);
    say('so the next point is data again', 1, 0.9);
    say('Yes okay', 2, 0.5);
    wait(1000);
    expect(shown).toHaveLength(3);
  });

  it('lets everything held through when the stream closes', () => {
    say('A line still waiting for its echo check', 1, 0.9);
    filter.flush();
    expect(shown).toHaveLength(1);
  });

  it('compares words, not punctuation or case', () => {
    expect(
      overlap(wordsOf("It's just an extra."), wordsOf('its JUST an extra')),
    ).toBeGreaterThanOrEqual(0.6);
    expect(overlap(wordsOf('fund shelters'), wordsOf('data mandatory'))).toBe(
      0,
    );
  });
});
