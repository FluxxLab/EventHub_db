import { IsInt, Max, Min, IsOptional, IsDateString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

/**
 * Cursor Pagination
 */
export class QueryCommentsDto {
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
}
