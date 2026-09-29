import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { BRAND_COLOR_PATTERN } from './edition-logo.dto';
import {
  AUTOMATIC_NOTIFICATIONS,
  CentreAction,
  EDITION_FEATURES,
  EditionCategory,
  EditionStatus,
} from '../entities/edition.entity';

/* ------------------------------------------------ help-screen info (nested) */

export class WifiInfoDto {
  @ApiProperty({ example: 'GS26-Delegates', maxLength: 100 })
  @IsString()
  @MaxLength(100)
  network: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  password?: string;
}

export class HelpDeskInfoDto {
  @ApiPropertyOptional({ example: '+234 800 000 0000', maxLength: 30 })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional({ example: '+234 800 000 0000', maxLength: 30 })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  whatsapp?: string;

  @ApiPropertyOptional({ example: 'help@picevents.ng' })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @ApiPropertyOptional({ example: 'Foyer, ground floor', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  location?: string;
}

export class BreakInfoDto {
  @ApiProperty({ example: 'Lunch', maxLength: 100 })
  @IsString()
  @MaxLength(100)
  label: string;

  @ApiProperty({ example: '2026-09-08T13:00:00+01:00' })
  @IsDateString()
  startsAt: string;

  @ApiProperty({ example: '2026-09-08T14:00:00+01:00' })
  @IsDateString()
  endsAt: string;

  @ApiPropertyOptional({ example: 'Garden terrace', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  location?: string;
}

export class EditionInfoDto {
  @ApiPropertyOptional({ type: WifiInfoDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => WifiInfoDto)
  wifi?: WifiInfoDto;

  @ApiPropertyOptional({ type: HelpDeskInfoDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => HelpDeskInfoDto)
  helpDesk?: HelpDeskInfoDto;

  @ApiPropertyOptional({ type: [BreakInfoDto], maxItems: 20 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => BreakInfoDto)
  breaks?: BreakInfoDto[];

  @ApiPropertyOptional({ example: 'Room 2B, first floor', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  prayerRoom?: string;

  @ApiPropertyOptional({
    example: 'Shuttles leave the Hilton every 30 minutes from 7am',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  transport?: string;

  @ApiPropertyOptional({ maxLength: 512 })
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(512)
  floorPlanUrl?: string;

  @ApiPropertyOptional({ type: [String], maxItems: 20 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  notes?: string[];
}

export class CreateEditionDto {
  @ApiProperty({ example: 'GS-27 Gender and Inclusion Summit', maxLength: 255 })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiProperty({ example: 'GS-27', maxLength: 50 })
  @IsString()
  @MaxLength(50)
  shortName: string;

  @ApiProperty({ example: '2027-09-07T08:00:00+01:00' })
  @IsDateString()
  startsAt: string;

  @ApiProperty({ example: '2027-09-08T17:00:00+01:00' })
  @IsDateString()
  endsAt: string;

  @ApiPropertyOptional({ example: 'Abuja, Nigeria', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  venue?: string;

  /** Street address for the app's venue page. Empty clears it. */
  @ApiPropertyOptional({
    example: 'Plot 1, Ahmadu Bello Way, Abuja',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  address?: string;

  /**
   * Lines printed under the edition's tickets. Left out on create, the
   * standard five; on update, send the full list, it replaces.
   */
  @ApiPropertyOptional({
    type: [String],
    maxItems: 20,
    example: ['Tickets are non-refundable unless the event is cancelled.'],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  ticketTerms?: string[];

  /** Defaults to draft, which is invisible to delegates. */
  @ApiPropertyOptional({ enum: EditionStatus })
  @IsOptional()
  @IsEnum(EditionStatus)
  status?: EditionStatus;

  /** Where the app files it on My Events. Defaults to summits. */
  @ApiPropertyOptional({ enum: EditionCategory })
  @IsOptional()
  @IsEnum(EditionCategory)
  category?: EditionCategory;

  @ApiPropertyOptional({ example: 'Abuja', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @ApiPropertyOptional({
    maxLength: 512,
    description: 'Cover artwork: an S3 key from an upload, or an http(s) URL',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  coverImage?: string;

  @ApiPropertyOptional({
    nullable: true,
    example: '#0f6b3a',
    description:
      "The event's button colour in the app, #rrggbb; null goes back to PIC navy. The logo is set with PUT /editions/:id/logo.",
  })
  @IsOptional()
  @IsString()
  @Matches(BRAND_COLOR_PATTERN, {
    message: 'brandColor must be a colour like #0f6b3a',
  })
  brandColor?: string | null;

  @ApiPropertyOptional({ description: 'Shown on the app details page' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  /** Venue latitude. Send with longitude, or neither; null clears both. */
  @ApiPropertyOptional({ example: 9.0579, nullable: true })
  @IsOptional()
  @IsLatitude()
  latitude?: number | null;

  @ApiPropertyOptional({ example: 7.4951, nullable: true })
  @IsOptional()
  @IsLongitude()
  longitude?: number | null;

  /**
   * Its tracks, as values from GET /catalog/tracks. Left out on create, every
   * active track; on update, send the full list, it replaces.
   */
  @ApiPropertyOptional({ type: [String], maxItems: 30, example: ['digital'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  trackValues?: string[];

  /** Its interests, as values from GET /catalog/interests. As trackValues. */
  @ApiPropertyOptional({ type: [String], maxItems: 200, example: ['Policy'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  interestValues?: string[];
}

export class UpdateEditionDto extends PartialType(CreateEditionDto) {
  /** Whether tickets can be bought right now. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  registrationOpen?: boolean;

  /** What the app's centre tab-bar button opens. */
  @ApiPropertyOptional({ enum: CentreAction })
  @IsOptional()
  @IsEnum(CentreAction)
  centreAction?: CentreAction;

  /** Overrides the label under it. Empty clears the override. */
  @ApiPropertyOptional({ maxLength: 20, example: 'My Pass' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  centreLabel?: string;

  /** Automatic pushes to switch off. Send the full list; it replaces. */
  @ApiPropertyOptional({
    isArray: true,
    enum: AUTOMATIC_NOTIFICATIONS,
    example: ['session-updated'],
  })
  @IsOptional()
  @IsArray()
  @IsIn(AUTOMATIC_NOTIFICATIONS, { each: true })
  mutedNotifications?: string[];

  /** App surfaces to switch on. Send the full list; it replaces. */
  @ApiPropertyOptional({
    isArray: true,
    enum: EDITION_FEATURES,
    example: ['schedule', 'speakers', 'captions'],
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(EDITION_FEATURES, { each: true })
  features?: string[];

  /** Help-screen content. Send the whole object; it replaces. Null clears. */
  @ApiPropertyOptional({ type: EditionInfoDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => EditionInfoDto)
  info?: EditionInfoDto | null;
}
