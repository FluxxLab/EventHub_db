import { IsString, MaxLength, Matches, IsUUID } from 'class-validator';
import { ApiTags, ApiProperty } from '@nestjs/swagger';

@ApiTags('Pitch Entries')
export class CreatePitchEntryDto {
  @ApiProperty({
    description: 'The name of the innovator',
  })
  @IsString()
  @MaxLength(255)
  innovatorName: string;

  @ApiProperty({
    description: 'Country of the innovator',
  })
  @IsString()
  country: string;

  @ApiProperty({
    description: 'keep track of the Session',
  })
  @IsString()
  @Matches(/^[a-z0-9-]{1,40}$/, { message: 'track must be a track value' })
  track: string;

  @ApiProperty({
    description: 'Description of the pitch',
  })
  @IsString()
  description: string;

  @ApiProperty({
    description: 'The topic (ballot) this pitch competes in',
  })
  @IsUUID()
  topicId: string;
}
