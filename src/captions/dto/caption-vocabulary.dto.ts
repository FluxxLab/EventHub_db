import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { MAX_TERM_LENGTH, MAX_TERMS } from '../caption-terms';

export class CaptionVocabularyDto {
  @ApiProperty({
    type: [String],
    example: ['full product', 'FMWASD', 'Kaduna'],
  })
  @IsArray()
  @ArrayMaxSize(MAX_TERMS)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(MAX_TERM_LENGTH, { each: true })
  terms: string[];
}
