import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class SetSpeakerRevealDto {
  @ApiProperty({
    description:
      'true publishes every speaker identity; false hides them again. ' +
      'Global - there is one line-up and one switch.',
  })
  @IsBoolean()
  revealed: boolean;
}
