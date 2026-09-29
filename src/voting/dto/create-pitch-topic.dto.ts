import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  IsUUID,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';

@ApiTags('Pitch Topics')
export class CreatePitchTopicDto {
  @ApiProperty({ description: 'Topic name as announced in the run-of-show' })
  @IsString()
  @MaxLength(160)
  name: string;

  @ApiPropertyOptional({ description: 'Presentation order, lowest first' })
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;

  /**
   * The event it is for. Required (26 Sep 2026): a topic defaulted to "the
   * current event" landed on the wrong ballot whenever two events ran at once.
   * Event organisers must name one of theirs.
   */
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  editionId: string;
}
