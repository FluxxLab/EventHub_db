import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  SPEAKER_NAME_KINDS,
  type SpeakerNameKind,
} from './speaker-name.entity';

export class CreateSpeakerNameDto {
  @ApiProperty({ enum: SPEAKER_NAME_KINDS })
  @IsIn(SPEAKER_NAME_KINDS)
  kind: SpeakerNameKind;

  @ApiProperty({
    example: 2,
    description: 'The voice index (0-based) or mic number (1-based)',
  })
  @IsInt()
  @Min(0)
  @Max(32767)
  key: number;

  @ApiProperty({ example: 'Dr Amina Bello' })
  @IsString()
  @Length(1, 255)
  name: string;

  @ApiPropertyOptional({ nullable: true, example: 'Ministry of Health' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  organisation?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "One of the session's programme speakers",
  })
  @IsOptional()
  @IsUUID()
  speakerId?: string | null;

  @ApiPropertyOptional({
    description:
      'When the name applies from (ISO). Defaults to the start of the current run for a voice, and to just before the session for a mic.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  fromAt?: string;
}

export class UpdateSpeakerNameDto {
  @ApiPropertyOptional({ enum: ['confirmed', 'rejected'] })
  @IsOptional()
  @IsIn(['confirmed', 'rejected'])
  status?: 'confirmed' | 'rejected';

  @ApiPropertyOptional({ example: 'Dr Amina Bello' })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  name?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  organisation?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsUUID()
  speakerId?: string | null;
}
