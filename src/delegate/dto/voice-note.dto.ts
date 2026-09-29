import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, Matches, Max, Min } from 'class-validator';

/**
 * Voice notes in DMs. What each platform records (expo-audio in the app):
 * iOS and Android AAC in an MPEG-4 container (.m4a, `audio/mp4`), Chrome and
 * Firefox Opus in WebM (`audio/webm`), Safari on the web MPEG-4 again. Plain
 * ADTS AAC is accepted for older Android builds. Each of these plays back on
 * the other platforms except WebM on older iOS (before 17.4).
 */
export const VOICE_NOTE_CONTENT_TYPES = [
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/webm',
] as const;

/** Two minutes: the app stops recording there. */
export const VOICE_NOTE_MAX_MS = 120_000;

/**
 * 4 MB. Two minutes of 64 kbps mono AAC is about 1 MB, and the web's Opus at
 * the browser default is similar; the headroom covers a device that ignores
 * the requested bitrate. The signed upload is bound to the declared size, so
 * a larger file cannot be put there at all.
 */
export const VOICE_NOTE_MAX_BYTES = 4 * 1024 * 1024;

/** Keys the API hands out for voice notes: `dm-audio/<senderId>/<uuid>`. */
export const VOICE_NOTE_FOLDER = 'dm-audio';

const UUID_PART =
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const VOICE_NOTE_KEY = new RegExp(
  `^${VOICE_NOTE_FOLDER}/(${UUID_PART})/(${UUID_PART})$`,
  'i',
);

export class VoiceNoteUploadDto {
  @ApiProperty({ enum: VOICE_NOTE_CONTENT_TYPES, example: 'audio/mp4' })
  @IsIn(VOICE_NOTE_CONTENT_TYPES)
  contentType: string;

  @ApiProperty({
    description:
      'Exact size of the file in bytes; the upload URL only accepts this size',
    example: 482133,
    maximum: VOICE_NOTE_MAX_BYTES,
  })
  @IsInt()
  @Min(1)
  @Max(VOICE_NOTE_MAX_BYTES)
  size: number;
}

/** A voice note the sender uploaded with a URL from `POST /delegates/me/voice-note-upload`. */
export class DirectMessageAudioDto {
  @ApiProperty({
    description: 'The key returned with the upload URL',
    example: 'dm-audio/6c1d…/0f3a…',
  })
  @IsString()
  @Matches(VOICE_NOTE_KEY, { message: 'audio.key is not a voice note key' })
  key: string;

  @ApiProperty({ example: 42000, minimum: 1, maximum: VOICE_NOTE_MAX_MS })
  @IsInt()
  @Min(1)
  @Max(VOICE_NOTE_MAX_MS)
  durationMs: number;

  @ApiProperty({ enum: VOICE_NOTE_CONTENT_TYPES, example: 'audio/mp4' })
  @IsIn(VOICE_NOTE_CONTENT_TYPES)
  contentType: string;
}
