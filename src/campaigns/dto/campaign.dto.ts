import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export const AUDIENCE_KINDS = ['all', 'checked_in', 'not_checked_in'] as const;

export class CampaignAudienceDto {
  @ApiProperty({ enum: AUDIENCE_KINDS, example: 'all' })
  @IsIn(AUDIENCE_KINDS)
  kind: (typeof AUDIENCE_KINDS)[number];

  @ApiProperty({
    type: [String],
    description: 'Only these tiers; empty is every tier',
  })
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  ticketTypeIds: string[];
}

/** Pictures in a campaign: what email apps show reliably. */
export const CAMPAIGN_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
] as const;
export const CAMPAIGN_IMAGE_FOLDER = 'campaigns';

const HEX = /^#[0-9a-f]{6}$/i;
/** A storage key of ours (a campaign upload, or the event's own logo or cover), never a URL. */
const STORAGE_KEY = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9/_.-]{0,499}$/;

export class CampaignImageUploadDto {
  @ApiProperty({ enum: CAMPAIGN_IMAGE_TYPES, example: 'image/png' })
  @IsIn(CAMPAIGN_IMAGE_TYPES)
  contentType: string;
}

export class CampaignDesignDto {
  @ApiPropertyOptional({ nullable: true, description: 'Storage key' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(STORAGE_KEY, { message: 'logo must be an uploaded picture' })
  logo: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Storage key' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(STORAGE_KEY, { message: 'banner must be an uploaded picture' })
  banner: string | null;

  @ApiProperty({ example: '#002d74' })
  @Matches(HEX, { message: 'headerColor must be a colour like #002d74' })
  headerColor: string;

  @ApiProperty({ example: '#002d74' })
  @Matches(HEX, { message: 'buttonColor must be a colour like #002d74' })
  buttonColor: string;

  @ApiProperty({ example: 'Policy Innovation Centre' })
  @IsString()
  @MaxLength(80)
  eyebrow: string;

  @ApiProperty()
  @IsBoolean()
  showEventName: boolean;

  @ApiProperty({ example: 'Questions? events@policycentre.org' })
  @IsString()
  @MaxLength(500)
  footer: string;
}

export class SaveCampaignDto {
  @ApiProperty({ example: 'Your badge and the programme for {{event}}' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  subject: string;

  @ApiProperty({
    description:
      'Plain text; blank lines make paragraphs. Merge fields: {{first_name}}, {{name}}, {{ticket_code}}, {{tier}}, {{event}}',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(20_000)
  body: string;

  @ApiPropertyOptional({ example: 'View the programme', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== '')
  @IsString()
  @MaxLength(60)
  buttonLabel?: string | null;

  @ApiPropertyOptional({
    example: 'https://policycentre.org/gs27',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== '')
  @IsUrl({ protocols: ['https', 'http'], require_protocol: true })
  @MaxLength(500)
  buttonUrl?: string | null;

  @ApiProperty({ type: CampaignAudienceDto })
  @ValidateNested()
  @Type(() => CampaignAudienceDto)
  audience: CampaignAudienceDto;

  @ApiPropertyOptional({
    type: CampaignDesignDto,
    nullable: true,
    description: 'Left out keeps the saved design; null is the PIC layout',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CampaignDesignDto)
  design?: CampaignDesignDto | null;
}

export class AudienceSizeDto {
  @ApiProperty({ type: CampaignAudienceDto })
  @ValidateNested()
  @Type(() => CampaignAudienceDto)
  audience: CampaignAudienceDto;
}
