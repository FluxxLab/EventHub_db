import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { TriviaOption } from '../entities/trivia-question.entity';

export class AnswerTriviaDto {
  @ApiProperty({
    enum: TriviaOption,
  })
  @IsEnum(TriviaOption)
  chosenOption: TriviaOption;
}
