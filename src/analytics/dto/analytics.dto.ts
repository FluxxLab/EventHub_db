import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  ANALYTICS_PLATFORMS,
  type AnalyticsPlatform,
} from '../entities/analytics-event.entity';

/** snake_case, letters and digits, 2..60 chars: the shape a SQL GROUP BY is happy with. */
export const EVENT_NAME = /^[a-z][a-z0-9_]{1,59}$/;

export class AnalyticsEventDto {
  @ApiProperty({ example: 'screen_view', pattern: EVENT_NAME.source })
  @IsString()
  @Matches(EVENT_NAME, {
    message:
      'name must be snake_case: a letter followed by 1-59 letters, digits or underscores',
  })
  name: string;

  @ApiProperty({
    example: '2026-09-08T09:12:00+01:00',
    description: 'When it happened on the device',
  })
  @IsDateString()
  at: string;

  @ApiPropertyOptional({
    example: { path: '/sessions/abc' },
    description: 'Free-form; `path` for screen_view, `feature` for feature_use',
  })
  @IsOptional()
  @IsObject()
  props?: Record<string, unknown>;
}

export class IngestEventsDto {
  @ApiProperty({ enum: ANALYTICS_PLATFORMS })
  @IsIn(ANALYTICS_PLATFORMS)
  platform: AnalyticsPlatform;

  @ApiPropertyOptional({ example: '1.4.2', maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  appVersion?: string;

  @ApiProperty({ type: [AnalyticsEventDto], minItems: 1, maxItems: 50 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AnalyticsEventDto)
  events: AnalyticsEventDto[];
}

export class SummaryQueryDto {
  @ApiPropertyOptional({ description: 'ISO 8601; defaults to 7 days ago' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO 8601; defaults to now' })
  @IsOptional()
  @IsDateString()
  to?: string;
}
