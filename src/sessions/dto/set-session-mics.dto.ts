import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/** The most channels a sound desk offers a room (the console opens up to 32). */
export const MAX_MICS = 32;

export class SessionMicDto {
  @ApiProperty({ minimum: 1, maximum: MAX_MICS, example: 1 })
  @IsInt()
  @Min(1)
  @Max(MAX_MICS)
  mic: number;

  /** One of the session's speakers; null with a label instead. */
  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  speakerId?: string | null;

  /** "Audience", or a guest not on the programme; used when no speaker is chosen. */
  @ApiPropertyOptional({ nullable: true, example: 'Audience' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(60)
  label?: string | null;
}

export class SetSessionMicsDto {
  @ApiProperty({ type: [SessionMicDto] })
  @IsArray()
  @ArrayMaxSize(MAX_MICS)
  @ValidateNested({ each: true })
  @Type(() => SessionMicDto)
  mics: SessionMicDto[];
}
