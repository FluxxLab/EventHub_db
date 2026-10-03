import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { AudienceSegment } from '../entities/notification.entity';

export class CreateNotificationDto {
  @ApiProperty({
    maxLength: 255,
    description: 'Push title shown on the device',
  })
  @IsString()
  @MaxLength(255)
  title: string;

  @ApiProperty({ description: 'Push body / inbox message text' })
  @IsString()
  body: string;

  @ApiPropertyOptional({ maxLength: 100, example: 'shedule-change' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category: string;

  @ApiProperty({ enum: AudienceSegment, example: AudienceSegment.ALL })
  @IsEnum(AudienceSegment)
  segment: AudienceSegment;

  /** The session this announcement is about; opens in the app when tapped. */
  @ApiPropertyOptional({ description: 'Session this announcement points at' })
  @IsOptional()
  @ValidateIf((_, value) => value !== '' && value !== null)
  @IsUUID()
  sessionId?: string;

  /** An address outside the app, opened in the browser when tapped. */
  @ApiPropertyOptional({ example: 'https://policycentre.org/communique' })
  @IsOptional()
  @ValidateIf((_, value) => value !== '' && value !== null)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(500)
  linkUrl?: string;

  @ApiPropertyOptional({
    description:
      'Also send on WhatsApp to delegates in the segment who opted in (an approved template; charged per message)',
  })
  @IsOptional()
  @IsBoolean()
  whatsapp?: boolean;

  /** Only holders of these ticket tiers of `editionId`; left out or empty, everyone at the event. */
  @ApiPropertyOptional({ type: [String], format: 'uuid' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  ticketTypeIds?: string[];

  /** The event it is for. Defaults to the current one; event organisers must name one of theirs. */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  editionId?: string;
}
