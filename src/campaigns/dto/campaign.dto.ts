import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
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
}

export class AudienceSizeDto {
  @ApiProperty({ type: CampaignAudienceDto })
  @ValidateNested()
  @Type(() => CampaignAudienceDto)
  audience: CampaignAudienceDto;
}
