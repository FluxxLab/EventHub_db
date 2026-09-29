import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateEditionRoomDto {
  /** Matched to sessions' room by name, ignoring case and spacing. */
  @ApiProperty({ example: 'Hall A', maxLength: 120 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional({
    example: 'Ground floor',
    maxLength: 60,
    nullable: true,
  })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsString()
  @MaxLength(60)
  floor?: string | null;

  @ApiPropertyOptional({
    example: 'Step-free access from the east lift',
    maxLength: 500,
    nullable: true,
  })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsString()
  @MaxLength(500)
  notes?: string | null;

  @ApiPropertyOptional({ minimum: 0, maximum: 10000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  sortOrder?: number;
}

export class UpdateEditionRoomDto extends PartialType(CreateEditionRoomDto) {}
