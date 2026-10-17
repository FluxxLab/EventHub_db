import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
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

/** What a capture desk records in, as MediaRecorder names it. */
export const BACKFILL_CONTENT_TYPES = ['audio/webm', 'audio/ogg'] as const;
/** About three hours of desk Opus; anything bigger is not one piece. */
export const BACKFILL_MAX_BYTES = 200_000_000;
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
}
