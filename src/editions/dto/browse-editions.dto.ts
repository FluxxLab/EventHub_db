import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { EditionCategory } from '../entities/edition.entity';

/** Filters for the app's My Events lists (FR-09 discovery). */
export class BrowseEditionsDto {
  @ApiPropertyOptional({ enum: EditionCategory })
  @IsOptional()
  @IsEnum(EditionCategory)
  category?: EditionCategory;

  @ApiPropertyOptional({ maxLength: 100, description: 'Name or city' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  /** `nearby` needs `lat` and `lng`, and adds `distanceKm` to each card. */
  @ApiPropertyOptional({
    enum: ['latest', 'popular', 'nearby'],
    default: 'latest',
  })
  @IsOptional()
  @IsIn(['latest', 'popular', 'nearby'])
  sort?: 'latest' | 'popular' | 'nearby';

  @ApiPropertyOptional({ minimum: -90, maximum: 90, example: 9.0579 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number;

  @ApiPropertyOptional({ minimum: -180, maximum: 180, example: 7.4951 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng?: number;

  /** Upcoming by default; `past` for editions that have ended, `all` for both. */
  @ApiPropertyOptional({
    enum: ['upcoming', 'past', 'all'],
    default: 'upcoming',
  })
  @IsOptional()
  @IsIn(['upcoming', 'past', 'all'])
  when?: 'upcoming' | 'past' | 'all';

  /**
   * free: no active tier costs anything (or there are no priced tiers);
   * paid: at least one active tier has a price above zero.
   */
  @ApiPropertyOptional({ enum: ['free', 'paid'] })
  @IsOptional()
  @IsIn(['free', 'paid'])
  price?: 'free' | 'paid';

  /**
   * Inclusive window on the start date. A bare date (2027-09-07) covers the
   * whole UTC day. Either one given makes `when` ignored.
   */
  @ApiPropertyOptional({ example: '2027-09-01' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ example: '2027-09-30' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
