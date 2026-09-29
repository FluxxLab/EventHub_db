import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finaliseWav, WAV_HEADER_BYTES, wavHeader } from './wav';

describe('WAV recording for venue streams', () => {
  it('writes a 16 kHz mono 16-bit PCM header', () => {
    const header = wavHeader({
      encoding: 'linear16',
      sampleRate: 16_000,
      channels: 1,
    });
    expect(header).toHaveLength(WAV_HEADER_BYTES);
    expect(header.toString('ascii', 0, 4)).toBe('RIFF');
    expect(header.toString('ascii', 8, 16)).toBe('WAVEfmt ');
    expect(header.readUInt16LE(20)).toBe(1); // PCM
    expect(header.readUInt16LE(22)).toBe(1); // mono
    expect(header.readUInt32LE(24)).toBe(16_000);
    expect(header.readUInt32LE(28)).toBe(32_000); // bytes per second
    expect(header.readUInt16LE(34)).toBe(16);
    expect(header.toString('ascii', 36, 40)).toBe('data');
  });

  it('fills in the sizes once the recording is closed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wav-'));
    const path = join(dir, 'room.wav');
    const pcm = Buffer.alloc(3200); // 100 ms
    await writeFile(
      path,
      Buffer.concat([
        wavHeader({ encoding: 'linear16', sampleRate: 16_000, channels: 1 }),
        pcm,
      ]),
    );
    await finaliseWav(path);
    const file = await readFile(path);
    expect(file.readUInt32LE(4)).toBe(WAV_HEADER_BYTES + 3200 - 8);
    expect(file.readUInt32LE(40)).toBe(3200);
    await rm(dir, { recursive: true });
  });
});
