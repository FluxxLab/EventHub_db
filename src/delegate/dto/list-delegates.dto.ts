import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { AccessTier } from '../entities/delegate.entity';

export class ListDelegatesDto {
  @ApiPropertyOptional({ description: 'Matches name, email, organisation' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: AccessTier })
  @IsOptional()
  @IsEnum(AccessTier)
  tier?: AccessTier;

  /** Only holders of this ticket tier (of `editionId`). */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  ticketTypeId?: string;

  /** Only people holding a ticket for this edition. Required of event organisers. */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  editionId?: string;

  @ApiPropertyOptional({ description: 'Thematic track slug' })
  @IsOptional()
  @IsString()
  track?: string;
}
