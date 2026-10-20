import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** A brief runs to a page or two; this is ten times that, and still a modest prompt. */
export const MAX_BRIEF_LENGTH = 50_000;

export class SetSessionBriefDto {
  /** The brief as text. Empty clears it. */
  @ApiProperty({ maxLength: MAX_BRIEF_LENGTH })
  @IsString()
  @MaxLength(MAX_BRIEF_LENGTH)
  text: string;

  /** The file it was read from, shown back to organisers. */
  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string;
}
