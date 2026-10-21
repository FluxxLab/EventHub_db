import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional, IsUUID } from 'class-validator';

export class MoveCaptionsDto {
  @ApiProperty({ description: 'The session the captions belong to' })
  @IsUUID()
  toSessionId: string;

  @ApiPropertyOptional({
    description:
      'Move only lines said at or after this time (ISO). All lines when absent.',
    example: '2026-10-21T11:25:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  since?: string;

  @ApiPropertyOptional({
    description:
      'And at or before this time (ISO): a stretch in the middle of a session. To the end when absent.',
  })
  @IsOptional()
  @IsISO8601()
  until?: string;
}
