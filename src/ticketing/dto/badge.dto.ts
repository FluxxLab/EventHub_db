import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  BADGE_ARTWORK_TYPES,
  BADGE_FIELDS,
  BADGE_SIZES,
} from '../badge-design';

const HEX = /^#[0-9a-f]{6}$/i;
const HEX_MESSAGE = 'colours are hex, like #002d74';

export class TierColourDto {
  @ApiProperty({ example: 'VIP' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  tier: string;

  @ApiProperty({ example: '#b8860b' })
  @Matches(HEX, { message: HEX_MESSAGE })
  colour: string;
}

export class BadgePlacementDto {
  @ApiProperty({ minimum: 0, maximum: 1, example: 0.5 })
  @IsNumber()
  @Min(0)
  @Max(1)
  x: number;

  @ApiProperty({ minimum: 0, maximum: 1, example: 0.5 })
  @IsNumber()
  @Min(0)
  @Max(1)
  y: number;

  @ApiProperty({ minimum: 0.5, maximum: 2, example: 1 })
  @IsNumber()
  @Min(0.5)
  @Max(2)
  scale: number;
}

export class BadgeLayoutDto {
  @ApiProperty({ type: BadgePlacementDto })
  @ValidateNested()
  @Type(() => BadgePlacementDto)
  photo: BadgePlacementDto;

  @ApiProperty({ type: BadgePlacementDto })
  @ValidateNested()
  @Type(() => BadgePlacementDto)
  who: BadgePlacementDto;

  @ApiProperty({ type: BadgePlacementDto })
  @ValidateNested()
  @Type(() => BadgePlacementDto)
  scan: BadgePlacementDto;
}

export class BadgeArtworkUploadDto {
  @ApiProperty({ enum: BADGE_ARTWORK_TYPES, example: 'image/png' })
  @IsIn(BADGE_ARTWORK_TYPES)
  contentType: string;
}

export class SaveBadgeDesignDto {
  @ApiProperty({ enum: BADGE_SIZES, example: 'a6' })
  @IsIn(BADGE_SIZES)
  size: (typeof BADGE_SIZES)[number];

  @ApiProperty({ example: '#002d74' })
  @Matches(HEX, { message: HEX_MESSAGE })
  accent: string;

  @ApiProperty({ enum: BADGE_FIELDS, isArray: true })
  @IsArray()
  @ArrayUnique()
  @IsIn(BADGE_FIELDS, { each: true })
  fields: (typeof BADGE_FIELDS)[number][];

  @ApiProperty({ type: [TierColourDto] })
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => TierColourDto)
  tierColours: TierColourDto[];

  @ApiPropertyOptional({
    description:
      'Storage key of uploaded artwork (from the upload URL); null or absent for the standard layout',
    nullable: true,
  })
  @IsOptional()
  @Matches(/^badges\/[0-9a-f-]{36}$/, {
    message: 'artwork must be a key from the badge upload URL',
  })
  artwork?: string | null;

  @ApiPropertyOptional({ type: BadgeLayoutDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => BadgeLayoutDto)
  layout?: BadgeLayoutDto | null;
}

export class BadgeListQueryDto {
  @ApiPropertyOptional({ description: 'Only this ticket tier' })
  @IsOptional()
  @IsUUID()
  ticketTypeId?: string;
}
