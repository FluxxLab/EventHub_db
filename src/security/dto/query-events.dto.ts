import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { EventSeverity } from '../entities/security-event.entity';

/** `a,b,c` in a query string -> ['a', 'b', 'c']; blanks dropped. */
const commaList = ({ value }: { value: unknown }) =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
    : value;

export class QueryEventsDto {
  @ApiPropertyOptional({ enum: EventSeverity })
  @IsOptional()
  @IsEnum(EventSeverity)
  severity?: EventSeverity;

  /** Only these event types, comma separated: `session_deleted,tier_changed`. */
  @ApiPropertyOptional({ example: 'session_deleted,tier_changed' })
  @IsOptional()
  @Transform(commaList)
  @IsArray()
  @ArrayMaxSize(60)
  @Matches(/^[a-z0-9_-]{2,60}$/, {
    each: true,
    message: 'each type must be an event type such as session_deleted',
  })
  types?: string[];

  /** Only what one person did. */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  actorId?: string;

  @ApiPropertyOptional({
    description: 'Only events at or after this ISO timestamp',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({
    description: 'Cursor: return events created before this ISO timestamp',
  })
  @IsOptional()
  @IsDateString()
  before?: string;

  @ApiPropertyOptional({ default: 50, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
