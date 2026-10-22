import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsInt,
  IsISO8601,
  IsNumber,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { BACKFILL_KEY_PATTERN } from './backfill-plan';

/**
 * What a capture desk records in, as MediaRecorder names it, and what a
 * stream's recording comes as (YouTube's audio is m4a; a video file works too).
 */
export const BACKFILL_CONTENT_TYPES = [
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/mpeg',
  'audio/aac',
  'audio/wav',
  'video/mp4',
  'video/webm',
] as const;
/** A whole day of a stream's audio fits; the caption service takes files up to 2 GB. */
export const BACKFILL_MAX_BYTES = 2_000_000_000;
/** Longest piece a desk may say it recorded. */
export const BACKFILL_MAX_DURATION_MS = 24 * 60 * 60_000;

export class BackfillUploadDto {
  @ApiProperty({ example: 'Main Hall' })
  @IsString()
  @Length(1, 255)
  room: string;

  @ApiProperty({ enum: BACKFILL_CONTENT_TYPES, example: 'audio/webm' })
  @IsIn(BACKFILL_CONTENT_TYPES)
  contentType: (typeof BACKFILL_CONTENT_TYPES)[number];

  @ApiProperty({ example: 4_800_000, description: 'Exact size of the upload' })
  @IsInt()
  @Min(1)
  @Max(BACKFILL_MAX_BYTES)
  bytes: number;
}

export class BackfillSubmitDto {
  @ApiProperty({ example: 'Main Hall' })
  @IsString()
  @Length(1, 255)
  room: string;

  @ApiProperty({
    example: 'caption-backfill/3f0c6c1e-4c0e-4f43-9d55-8b8f5a6f2a10',
    description: 'The key upload-url returned',
  })
  @IsString()
  @Matches(BACKFILL_KEY_PATTERN)
  key: string;

  @ApiProperty({
    example: '2026-10-17T09:30:00.000Z',
    description: "The desk's clock when the piece began",
  })
  @IsISO8601({ strict: true })
  startedAt: string;

  @ApiProperty({ example: 600_000 })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(1)
  @Max(BACKFILL_MAX_DURATION_MS)
  durationMs: number;

  @ApiProperty({
    example: '2026-10-17T11:02:13.000Z',
    description: "The desk's clock now, to correct for its skew",
  })
  @IsISO8601({ strict: true })
  deskNow: string;

  @ApiProperty({
    required: false,
    description:
      "Replace the live captions over the recording's hours with its lines (a stream's recording), instead of only filling gaps",
  })
  @IsOptional()
  @IsBoolean()
  replace?: boolean;
}
