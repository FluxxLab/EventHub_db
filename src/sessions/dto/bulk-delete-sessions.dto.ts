import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsUUID,
} from 'class-validator';

export class BulkDeleteSessionsDto {
  @ApiProperty({ type: [String], description: 'Session ids to delete' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  ids: string[];

  @ApiPropertyOptional({
    description:
      'Also delete sessions that have attendance, comments or captions',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
