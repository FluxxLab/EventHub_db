import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateTriviaQuestionDto } from './create-trivia.dto';

/** Everything but the event: a question is not moved between events. */
export class UpdateTriviaQuestionDto extends PartialType(
  OmitType(CreateTriviaQuestionDto, ['editionId'] as const),
) {}
