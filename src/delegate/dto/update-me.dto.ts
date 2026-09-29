import {
  IsOptional,
  IsString,
  IsArray,
  ArrayMaxSize,
  IsBoolean,
  IsIn,
  Length,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { normalisePhone } from '../../common/phone';
import { BIO_MAX, GENDERS } from '../entities/delegate.entity';
import type { Gender } from '../entities/delegate.entity';

/** Most interests a profile may hold. Published to the app by GET /catalog. */
export const INTEREST_MAX = 5;

export class UpdateMeDto {
  @ApiPropertyOptional({
    type: [String],
    description: 'Array of delegate IDs to update',
  })
  /**
   * ArrayMaxSize takes no `each` - with it, the size check runs against every
   * *element*, and a string is never an array, so any non-empty tracks or
   * interests failed validation outright. That is why onboarding could not
   * save: the 400 fired before the handler ever ran. Element length gets its
   * own each-constraint instead.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @ArrayMaxSize(50)
  tracks?: string[];

  @ApiPropertyOptional({
    type: [String],
    maxItems: INTEREST_MAX,
    description:
      'Values from GET /catalog interests; unknown values are refused unless already saved',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @ArrayMaxSize(INTEREST_MAX)
  interests?: string[];

  @ApiPropertyOptional({
    maxLength: 255,
    example: 'Policy Innovation Centre',
    description:
      'Where the delegate works or studies; send an empty string to clear',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  organisation?: string;

  @ApiPropertyOptional({
    maxLength: 100,
    example: 'Programme Officer',
    description:
      'Job title, shown on the profile; send an empty string to clear',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  title?: string;

  @ApiPropertyOptional({
    description:
      'Object key from POST /delegates/me/avatar-upload, saved once the PUT to S3 succeeds. A full URL is also accepted, for an externally hosted avatar.',
    example: 'delegate-avatars/6f1c0f6e-2d1a-4a1e-9a0e-2c7f3f0f9b21',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  /**
   * Was @IsUrl(), which rejected the key the upload flow now returns - the
   * PATCH 400d, so the photo reached S3 and the column stayed null.
   *
   * The prefix is pinned deliberately: without it a delegate could point their
   * avatar at any object in the bucket, including someone else's upload.
   */
  @Matches(/^(https?:\/\/\S+|delegate-avatars\/[A-Za-z0-9._-]+)$/, {
    message:
      'avatarUrl must be a delegate-avatars/... key from /delegates/me/avatar-upload, or an http(s) URL',
  })
  avatarUrl?: string;

  @ApiPropertyOptional({ minLength: 2, maxLength: 100, example: 'Ada Obi' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(2, 100, { message: 'Your name must be 2 to 100 characters' })
  name?: string;

  @ApiPropertyOptional({
    example: '08012345678 or +2349030000000',
    description:
      'Stored in E.164 like registration; send an empty string to clear',
  })
  @IsOptional()
  // same normalisation as registration - see common/phone.ts; '' stays '' so it clears
  @Transform(({ value }) =>
    typeof value === 'string' && value.trim()
      ? normalisePhone(value.trim())
      : typeof value === 'string'
        ? ''
        : value,
  )
  @IsString()
  @Matches(/^(\+?\d{7,15})?$/, {
    message: 'Enter a phone number of 7 to 15 digits',
  })
  phone?: string;

  @ApiPropertyOptional({
    enum: GENDERS,
    nullable: true,
    description: 'null clears the answer',
  })
  // null is a value here (it clears), so only a missing field is skipped
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsIn(GENDERS, {
    message: `gender must be one of ${GENDERS.join(', ')}, or null`,
  })
  gender?: Gender | null;

  @ApiPropertyOptional({
    description:
      'false hides you from the delegate directory, search and attendee lists',
  })
  @IsOptional()
  @IsBoolean()
  directoryVisible?: boolean;

  @ApiPropertyOptional({
    description:
      'Announcements on WhatsApp at the profile phone number; needs a phone on the profile',
  })
  @IsOptional()
  @IsBoolean()
  whatsappOptIn?: boolean;

  @ApiPropertyOptional({
    maxLength: BIO_MAX,
    example: 'Leads the maternal health portfolio across West Africa.',
    description:
      'A short "about me" shown on your profile; trimmed, send an empty string to clear',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(BIO_MAX, {
    message: `Your bio can be up to ${BIO_MAX} characters`,
  })
  bio?: string;
}
