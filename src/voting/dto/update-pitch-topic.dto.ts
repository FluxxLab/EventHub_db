import { OmitType, PartialType } from '@nestjs/swagger';
import { CreatePitchTopicDto } from './create-pitch-topic.dto';

/** Everything but the event: a topic is not moved between events. */
export class UpdatePitchTopicDto extends PartialType(
  OmitType(CreatePitchTopicDto, ['editionId'] as const),
) {}
