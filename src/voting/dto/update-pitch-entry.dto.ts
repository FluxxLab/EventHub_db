import { PartialType } from '@nestjs/swagger';
import { CreatePitchEntryDto } from './create-pitch-entry.dto';

export class UpdatePitchEntryDto extends PartialType(CreatePitchEntryDto) {}
