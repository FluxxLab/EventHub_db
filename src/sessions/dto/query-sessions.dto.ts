import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { SessionStatus } from '../entities/session.entity';

export class QuerySessionsDto {
  /**
   * Which summit's programme. Defaults to the current edition, which is what
   * the venue screens want; the app passes it explicitly so a delegate can
   * open an earlier edition's agenda from their tickets.
   */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  editionId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2)
  day?: number;

  @ApiPropertyOptional({ example: 'digital' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  track?: string;

  @ApiPropertyOptional({ enum: SessionStatus })
  @IsOptional()
  @IsEnum(SessionStatus)
  status?: SessionStatus;
}
