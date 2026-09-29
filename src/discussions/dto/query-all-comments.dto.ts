import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

/**
 * Moderators need the opposite default to delegates: a hidden comment is the
 * one they most often want to look at again, so hidden rows are included
 * unless asked otherwise.
 */
export enum HiddenFilter {
  INCLUDE = 'include',
  EXCLUDE = 'exclude',
  ONLY = 'only',
}

/** Cursor pagination, same shape as QueryCommentsDto. */
export class QueryAllCommentsDto {
  @ApiPropertyOptional({ default: 50, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 50;

  @ApiPropertyOptional({
    description: 'ISO timestamp cursor - return comments created before this',
  })
  @IsOptional()
  @IsDateString()
  before?: string;

  @ApiPropertyOptional({ description: 'Only comments delegates have reported' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  flagged?: boolean;

  @ApiPropertyOptional({ enum: HiddenFilter, default: HiddenFilter.INCLUDE })
  @IsOptional()
  @IsEnum(HiddenFilter)
  hidden?: HiddenFilter = HiddenFilter.INCLUDE;

  @ApiPropertyOptional({ description: 'Narrow to a single session' })
  @IsOptional()
  @IsUUID()
  sessionId?: string;
}
