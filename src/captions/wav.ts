import { open } from 'node:fs/promises';
import type { RawAudioFormat } from './transcription/transcription.interface';

/** Size of the canonical PCM WAV header written by wavHeader. */
export const WAV_HEADER_BYTES = 44;

/**
 * A PCM WAV header for a recording whose length is not known yet. The two
 * size fields are written as zero and filled in by finaliseWav once the file
 * is closed; the archive pass (Deepgram's batch API) reads the format from
 * this header, since raw PCM carries nothing else to go on.
 */
export function wavHeader(format: RawAudioFormat): Buffer {
  const bytesPerSample = 2; // linear16
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(0, 4); // RIFF size, patched on close
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(
    format.sampleRate * format.channels * bytesPerSample,
    28,
  );
  header.writeUInt16LE(format.channels * bytesPerSample, 32);
  header.writeUInt16LE(bytesPerSample * 8, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(0, 40); // data size, patched on close
  return header;
}

/** Fills in the RIFF and data sizes of a closed recording started with wavHeader. */
export async function finaliseWav(path: string): Promise<void> {
  const file = await open(path, 'r+');
  try {
    const { size } = await file.stat();
    const field = Buffer.alloc(4);
    field.writeUInt32LE(Math.max(0, size - 8));
    await file.write(field, 0, 4, 4);
    field.writeUInt32LE(Math.max(0, size - WAV_HEADER_BYTES));
    await file.write(field, 0, 4, 40);
  } finally {
    await file.close();
  }
}
