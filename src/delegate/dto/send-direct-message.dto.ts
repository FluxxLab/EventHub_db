import { Type } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { DirectMessageAudioDto } from './voice-note.dto';

export class SendDirectMessageDto {
  /**
   * The text. Required unless the message is a voice note, which may carry
   * a caption or nothing; the service refuses a message with neither.
   */
  @ApiPropertyOptional({
    description: 'Message body text (optional for a voice note)',
    example: 'Hi Fatima! See you at the GBV roundtable at 4pm?',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  body?: string;

  @ApiPropertyOptional({
    description: 'A voice note uploaded by the sender',
    type: DirectMessageAudioDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => DirectMessageAudioDto)
  audio?: DirectMessageAudioDto;

  /**
   * The message being replied to. Optional, and validated server-side against
   * the same thread - a reply must not be able to quote a message from a
   * conversation the sender is not part of.
   */
  @ApiPropertyOptional({
    description: 'Id of the message this one replies to',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  replyToId?: string;
}
