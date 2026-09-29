import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEnum,
  IsIn,
  ValidateNested,
  ArrayMaxSize,
  IsArray,
  IsUUID,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { SessionStatus } from '../entities/session.entity';
import {
  ROOM_PLACEHOLDER,
  ROOM_PLACEHOLDER_MESSAGE,
  SESSION_TYPES,
  normaliseRoom,
  normaliseSessionType,
} from '../session-types';

/** ISO 8601 with an explicit zone: a trailing `Z` or `±HH:MM`. */
const TZ_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Anything that is not (entirely) a placeholder. A negative lookahead over
 * the same regex the quality report uses, so the two cannot disagree about
 * what counts as "no room yet".
 */
const REAL_ROOM = new RegExp(`^(?!${ROOM_PLACEHOLDER.source.slice(1)})`, 'i');

export class SessionVideoLinkDto {
  @ApiProperty({ example: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(500)
  url: string;

  @ApiPropertyOptional({ example: 'Part 1: Opening remarks', maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  title?: string;
}

export class CreateSessionDto {
  @ApiProperty()
  @IsString()
  @MaxLength(255)
  title: string;

  @ApiProperty()
  @IsString()
  description: string;

  @ApiProperty({
    example: 1,
  })
  @IsInt()
  @Min(1)
  @Max(2)
  day: number;

  /**
   * The offset is mandatory. `new Date('2026-09-08T09:00:00')` is read in
   * whatever zone the process runs in - UTC in the container, the operator's
   * laptop in a browser - so an offset-less string stores a different instant
   * depending on who parsed it. Rejecting it here turns a silent one-hour
   * drift into a 400 the client sees.
   */
  @ApiProperty({ example: '2026-09-08T08:00:00+01:00' })
  @IsDateString()
  @Matches(TZ_OFFSET, {
    message: 'startsAt must carry a timezone offset, e.g. +01:00',
  })
  startsAt: string;

  @ApiProperty({ example: '2026-09-08T08:00:00+01:00' })
  @IsDateString()
  @Matches(TZ_OFFSET, {
    message: 'endsAt must carry a timezone offset, e.g. +01:00',
  })
  endsAt: string;

  /**
   * Trimmed and de-spaced before validation, then refused when nothing real
   * is left: captions are routed by room, so "TBC" would be a room several
   * sessions share (see session-types.ts).
   */
  @ApiProperty({ example: 'Hestel Hall' })
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normaliseRoom(value) : value,
  )
  @Matches(REAL_ROOM, { message: ROOM_PLACEHOLDER_MESSAGE })
  @MaxLength(255)
  room: string;

  /**
   * One of the edition's tracks (GET /sessions/tracks) or `general`; the
   * service checks it against the edition the session belongs to.
   */
  @ApiProperty({ example: 'digital' })
  @IsString()
  @Matches(/^[a-z0-9-]{1,40}$/, { message: 'track must be a track value' })
  track: string;

  /**
   * Free text on the way in, one of SESSION_TYPES on the way out. The
   * normaliser folds "Plenary Session" and friends onto the list; whatever
   * it cannot place is left as typed so the validator can name it in the
   * 400 along with the values that would have worked.
   */
  @ApiProperty({ enum: SESSION_TYPES, example: 'parallel' })
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? (normaliseSessionType(value) ?? value) : value,
  )
  @IsIn(SESSION_TYPES, {
    message: `type must be one of: ${SESSION_TYPES.join(', ')}`,
  })
  type: string;

  @ApiPropertyOptional()
  @IsOptional()
  audience?: string;

  /**
   * Validated as a URL rather than a YouTube id so the field survives a
   * change of video platform. Empty string is accepted and stored as null,
   * because that is what an operator clearing the box actually sends.
   */
  @ApiPropertyOptional({
    example: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    description: 'Link to the session recording or live stream',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== '' && value !== null)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(500)
  videoUrl?: string;

  /**
   * Every recording, in order. Supersedes `videoUrl`, which is derived from
   * the first entry for clients that predate this list. Send the full list;
   * it replaces.
   */
  @ApiPropertyOptional({ type: [SessionVideoLinkDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => SessionVideoLinkDto)
  videos?: SessionVideoLinkDto[];

  @ApiPropertyOptional({
    type: [String],
  })
  @IsOptional()
  speakerIds?: string[];

  @ApiPropertyOptional({
    enum: SessionStatus,
    default: SessionStatus.SCHEDULED,
  })
  @IsOptional()
  @IsEnum(SessionStatus)
  status?: SessionStatus;

  /**
   * Which summit this session belongs to. Defaults to the current one, which
   * is what the console wants almost always; naming one explicitly is how
   * next year's programme gets built before it is made current.
   */
  @ApiPropertyOptional({ description: 'Defaults to the current edition' })
  @IsOptional()
  @IsUUID()
  editionId?: string;
}
