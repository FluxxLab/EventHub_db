import { deskAudio } from './captions.gateway';

/**
 * What a sound desk says it is sending when it starts a room: one mic per
 * channel as 16 kHz PCM, or (anything else) the WebM it always sent.
 */
describe('a desk starting a multi-mic room', () => {
  const pcm = (channels: unknown) => ({
    room: 'Hall A',
    audio: { encoding: 'linear16', sampleRate: 16_000, channels },
  });

  it('takes 2 to 32 mics of 16 kHz PCM', () => {
    expect(deskAudio(pcm(4))).toEqual({
      encoding: 'linear16',
      sampleRate: 16_000,
      channels: 4,
    });
    expect(deskAudio(pcm(32))?.channels).toBe(32);
  });

  it('treats one channel, too many, or another format as WebM', () => {
    expect(deskAudio(pcm(1))).toBeUndefined();
    expect(deskAudio(pcm(33))).toBeUndefined();
    expect(deskAudio(pcm(2.5))).toBeUndefined();
    expect(
      deskAudio({
        audio: { encoding: 'opus', sampleRate: 16_000, channels: 2 },
      }),
    ).toBeUndefined();
    expect(
      deskAudio({
        audio: { encoding: 'linear16', sampleRate: 48_000, channels: 2 },
      }),
    ).toBeUndefined();
    expect(deskAudio({ room: 'Hall A' })).toBeUndefined();
    expect(deskAudio(null)).toBeUndefined();
  });
});
