import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
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
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export const GALLERY_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
/** A camera's JPEG is 5–12 MB; anything bigger should be exported smaller first. */
export const GALLERY_MAX_BYTES = 15 * 1024 * 1024;
/** Photos added per call; the console sends a big upload in batches of this. */
export const GALLERY_BATCH = 50;

export class GalleryUploadDto {
  @ApiProperty({ enum: GALLERY_IMAGE_TYPES })
  @IsIn(GALLERY_IMAGE_TYPES)
  contentType: string;

  @ApiProperty({
    description: 'Exact size in bytes; bound into the signature',
    maximum: GALLERY_MAX_BYTES,
  })
  @IsInt()
  @Min(1)
  @Max(GALLERY_MAX_BYTES)
  contentLength: number;
}

export class SaveAlbumDto {
  @ApiProperty({ example: 'Day 1: opening plenary' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;
}

export class UpdateAlbumDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  coverPhotoId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class NewPhotoDto {
  @ApiProperty() @IsString() @MaxLength(255) key: string;
  @ApiProperty() @IsString() @MaxLength(255) thumbKey: string;
  @ApiProperty() @IsInt() @Min(1) @Max(20000) width: number;
  @ApiProperty() @IsInt() @Min(1) @Max(20000) height: number;
  @ApiProperty() @IsInt() @Min(1) @Max(GALLERY_MAX_BYTES) sizeBytes: number;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(300)
  caption?: string | null;
}

export class AddPhotosDto {
  @ApiProperty({ type: [NewPhotoDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(GALLERY_BATCH)
  @ValidateNested({ each: true })
  @Type(() => NewPhotoDto)
  photos: NewPhotoDto[];
}

export class UpdatePhotoDto {
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(300)
  caption?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
