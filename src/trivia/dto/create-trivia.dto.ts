import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { TriviaOption } from '../entities/trivia-question.entity';

export class CreateTriviaQuestionDto {
  @ApiProperty({
    description: 'The text of the trivia questions',
  })
  @IsString()
  text: string;

  @ApiProperty({
    description: 'option',
  })
  @IsString()
  optionA: string;

  @ApiProperty({
    description: 'option',
  })
  @IsString()
  optionB: string;

  @ApiProperty({
    description: 'option',
  })
  @IsString()
  optionC: string;

  @ApiProperty({
    description: 'option',
  })
  @IsString()
  optionD: string;

  @ApiProperty({
    enum: TriviaOption,
  })
  @IsEnum(TriviaOption)
  correctOption: TriviaOption;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  explanation?: string;

  /**
   * The event it is for. Required (26 Sep 2026): its leaderboard and its
   * room are that event's, so it cannot be guessed. Event organisers must
   * name one of theirs.
   */
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  editionId: string;
}
