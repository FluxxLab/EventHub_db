import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { QuestionStatus } from '../entities/session-question.entity';

export class CreateQuestionDto {
  @ApiProperty({ maxLength: 280, example: 'How is the fund allocated?' })
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsNotEmpty({ message: 'A question cannot be empty' })
  @MaxLength(280)
  text: string;
}

export class UpdateQuestionStatusDto {
  @ApiProperty({ enum: QuestionStatus })
  @IsEnum(QuestionStatus)
  status: QuestionStatus;
}

export class ListQuestionsQueryDto {
  @ApiPropertyOptional({
    description:
      'Include dismissed questions. Honoured for admins and session admins only.',
  })
  @IsOptional()
  @Transform(
    ({ value }: { value: unknown }) => value === true || value === 'true',
  )
  @IsBoolean()
  all?: boolean;
}
