import { PartialType } from '@nestjs/swagger';
import { CreateSpeakerDto } from './create-speaker.dto';

/** Any of the speaker's fields; role and organisation may be cleared with an empty string. */
export class UpdateSpeakerDto extends PartialType(CreateSpeakerDto) {}
