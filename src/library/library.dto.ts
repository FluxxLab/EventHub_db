import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { LIBRARY_KINDS } from './library-item.entity';

/** Files organisers can upload: documents, slides, spreadsheets and audio. Videos are links. */
export const LIBRARY_FILE_TYPES = {
  'application/pdf': 'document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    'document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
    'document',
  'audio/mpeg': 'audio',
  'audio/mp4': 'audio',
} as const;
export const LIBRARY_MAX_BYTES = 100 * 1024 * 1024;

export class LibraryUploadDto {
  @ApiProperty({ enum: Object.keys(LIBRARY_FILE_TYPES) })
  @IsIn(Object.keys(LIBRARY_FILE_TYPES))
  contentType: string;

  @ApiProperty({ maximum: LIBRARY_MAX_BYTES })
  @IsInt()
  @Min(1)
  @Max(LIBRARY_MAX_BYTES)
  contentLength: number;
}

export class SaveLibraryItemDto {
  @ApiProperty({ example: 'Gender budgeting toolkit' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @ApiProperty({ enum: LIBRARY_KINDS })
  @IsIn(LIBRARY_KINDS)
  kind: (typeof LIBRARY_KINDS)[number];

  @ApiProperty({
    description: 'A key from the library upload URL, or an https address',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  url: string;

  @ApiPropertyOptional({ nullable: true, example: 'Toolkits' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(80)
  topic?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '2.4 MB' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(20)
  sizeLabel?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateLibraryItemDto extends PartialType(SaveLibraryItemDto) {}
