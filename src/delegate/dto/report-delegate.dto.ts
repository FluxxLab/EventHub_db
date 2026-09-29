import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export const REPORT_REASONS = [
  'harassment',
  'spam',
  'impersonation',
  'inappropriate',
  'other',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/** A delegate reporting another (App Store user-generated-content requirement). */
export class ReportDelegateDto {
  @ApiProperty({ enum: REPORT_REASONS })
  @IsIn(REPORT_REASONS)
  reason: ReportReason;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  details?: string;
}
