import {
  IsString,
  IsNotEmpty,
  MaxLength,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateCommentDto {
  @ApiProperty({
    description: 'The comment body',
    example: 'This is a comment',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  body: string;

  @ApiPropertyOptional({
    description:
      'Idempotency key the app makes when the comment is written (UUID). Sending the same one again returns the comment already saved instead of posting it twice.',
  })
  @IsOptional()
  @IsUUID()
  clientId?: string;
}
