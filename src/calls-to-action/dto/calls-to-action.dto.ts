import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { CTA_TYPES } from '../entities/call-to-action.entity';

/** The statuses a reviewer sets; `merged` only comes from a merge. */
export const REVIEW_STATUSES = ['suggested', 'approved', 'rejected'] as const;

/** Text that may be cleared: a string, or null to empty it. */
const Optional = (max: number) => (target: object, key: string) => {
  IsOptional()(target, key);
  ValidateIf((_, v) => v !== null)(target, key);
  IsString()(target, key);
  MaxLength(max)(target, key);
};

export class SaveCallToActionDto {
  @ApiPropertyOptional({ enum: CTA_TYPES })
  @IsOptional()
  @IsIn(CTA_TYPES)
  type?: (typeof CTA_TYPES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  action?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  shortText?: string;

  @ApiPropertyOptional({ example: 'Federal Ministry of Women Affairs' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  directedAt?: string;

  @ApiPropertyOptional({ nullable: true })
  @Optional(200)
  proposedBy?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @Optional(200)
  proposedByOrganisation?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @Optional(120)
  deadline?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @Optional(120)
  amount?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @Optional(120)
  theme?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @Optional(2000)
  quote?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  needsDetail?: boolean;

  @ApiPropertyOptional({ enum: REVIEW_STATUSES })
  @IsOptional()
  @IsIn(REVIEW_STATUSES)
  status?: (typeof REVIEW_STATUSES)[number];
}

/** One added by hand: the action, its slide line and its target are needed. */
export class CreateCallToActionDto extends SaveCallToActionDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  declare action: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  declare directedAt: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  sessionId?: string | null;
}

export class MergeCallsToActionDto {
  /** The one kept; the others fold into it. */
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  into: string;

  @ApiProperty({ type: [String], format: 'uuid' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  ids: string[];
}

/** What a deck covers: one session (a single slide) or one day (the full deck). */
export class DeckScopeDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'One session: a single slide',
  })
  @IsOptional()
  @IsUUID()
  sessionId?: string;

  @ApiPropertyOptional({
    minimum: 1,
    description: 'One day of the event: the full deck',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  day?: number;
}
