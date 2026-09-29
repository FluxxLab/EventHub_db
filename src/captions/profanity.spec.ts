import { maskProfanity } from './profanity';

/**
 * The failure that matters here is a false positive: masking a word nobody
 * swore silently removes something a speaker actually said, in front of the
 * room, and nothing reports it. Most of these guard that direction.
 */
describe('maskProfanity', () => {
  it('masks a term and keeps the line the same length', () => {
    expect(maskProfanity('this is shit')).toBe('this is ****');
  });

  it('masks regardless of case', () => {
    expect(maskProfanity('SHIT and Shit')).toBe('**** and ****');
  });

  it('masks common suffixed forms', () => {
    expect(maskProfanity('bastards')).toBe('********');
    expect(maskProfanity('pissing')).toBe('*******');
  });

  it('masks the Nigerian terms Deepgram does not carry', () => {
    expect(maskProfanity('na mumu be that')).toBe('na **** be that');
    expect(maskProfanity('werey')).toBe('*****');
  });

  it('leaves an innocent word that contains a term alone', () => {
    // the Scunthorpe problem, and its many relatives
    expect(maskProfanity('assassinate')).toBe('assassinate');
    expect(maskProfanity('Scunthorpe')).toBe('Scunthorpe');
    expect(maskProfanity('classic')).toBe('classic');
    expect(maskProfanity('dictionary')).toBe('dictionary');
    expect(maskProfanity('shitake')).toBe('shitake');
  });

  it('leaves ordinary summit language untouched', () => {
    const line =
      'Welcome to the Gender and Inclusion Summit - our focus is the last mile.';
    expect(maskProfanity(line)).toBe(line);
  });

  it('masks every occurrence in a line, not just the first', () => {
    expect(maskProfanity('shit and shit')).toBe('**** and ****');
  });

  it('handles empty and whitespace input without throwing', () => {
    expect(maskProfanity('')).toBe('');
    expect(maskProfanity('   ')).toBe('   ');
  });
});
