import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const MIN_POLL_OPTIONS = 2;
export const MAX_POLL_OPTIONS = 6;

export class CreatePollDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  editionId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  sessionId?: string;

  @ApiProperty({ maxLength: 200, example: 'Which track should GS-27 add?' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  question: string;

  @ApiProperty({
    type: [String],
    minItems: MIN_POLL_OPTIONS,
    maxItems: MAX_POLL_OPTIONS,
  })
  @IsArray()
  @ArrayMinSize(MIN_POLL_OPTIONS)
  @ArrayMaxSize(MAX_POLL_OPTIONS)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(100, { each: true })
  options: string[];

  @ApiPropertyOptional({
    description: 'Show the running tally to delegates while open',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  showResults?: boolean;
}

export class UpdatePollDto extends PartialType(CreatePollDto) {}

export class VotePollDto {
  @ApiProperty({ minimum: 0, maximum: MAX_POLL_OPTIONS - 1 })
  @IsInt()
  @Min(0)
  @Max(MAX_POLL_OPTIONS - 1)
  optionIndex: number;
}
