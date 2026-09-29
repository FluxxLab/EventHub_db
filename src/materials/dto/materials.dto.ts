import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { MaterialKind } from '../entities/session-material.entity';

export class CreateMaterialDto {
  @ApiProperty({ maxLength: 200, example: 'Opening plenary slides' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @ApiProperty({
    maxLength: 1000,
    description:
      'An https URL, or the `key` returned by POST /documents/upload-url (signed when read)',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  url: string;

  @ApiProperty({ enum: MaterialKind })
  @IsEnum(MaterialKind)
  kind: MaterialKind;

  @ApiPropertyOptional({ maxLength: 20, example: '2.4 MB' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  sizeLabel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class UpdateMaterialDto extends PartialType(CreateMaterialDto) {}
