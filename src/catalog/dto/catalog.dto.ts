import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateInterestDto {
  /** Stored on delegates; cannot be changed afterwards. */
  @ApiProperty({ example: 'Policy', maxLength: 60 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  value: string;

  /** Defaults to the value. */
  @ApiPropertyOptional({ example: 'Policy', maxLength: 60 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  label?: string;

  /** Defaults to after the last option. */
  @ApiPropertyOptional({ minimum: 0, maximum: 10000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  sortOrder?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Everything but the value, which delegates' saved interests point at. */
export class UpdateInterestDto {
  @ApiPropertyOptional({ maxLength: 60 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  label?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 10000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  sortOrder?: number;

  /** false retires the option: hidden from pickers, kept on profiles. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateCategoryDto {
  @ApiPropertyOptional({ example: 'Classes & Training', maxLength: 60 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  label?: string;

  /**
   * A category-images/... key from the image-upload route, or an http(s)
   * URL. Null clears it, and the app falls back to an edition's cover.
   */
  @ApiPropertyOptional({
    nullable: true,
    maxLength: 500,
    example: 'category-images/6f1c0f6e-2d1a-4a1e-9a0e-2c7f3f0f9b21',
  })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsString()
  @MaxLength(500)
  // pinned to our folder so a console user cannot point a tile at any object in the bucket
  @Matches(/^(https?:\/\/\S+|category-images\/[A-Za-z0-9._-]+)$/, {
    message:
      'imageKey must be a category-images/... key from the image-upload route, or an http(s) URL',
  })
  imageKey?: string | null;

  @ApiPropertyOptional({ minimum: 0, maximum: 10000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  sortOrder?: number;
}

export class CreateTrackDto {
  /** Its value is made from this and never changes; relabel freely later. */
  @ApiProperty({ example: 'Climate & Environment', maxLength: 80 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  label: string;

  @ApiPropertyOptional({
    example: 'Adaptation, energy and green jobs',
    maxLength: 120,
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  hint?: string;

  /** Defaults to after the last track. */
  @ApiPropertyOptional({ minimum: 0, maximum: 10000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  sortOrder?: number;
}

/** Everything but the value, which sessions and profiles point at. */
export class UpdateTrackDto {
  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  label?: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  hint?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 10000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  sortOrder?: number;

  /** false retires it: no longer offered to events, kept where it is used. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
