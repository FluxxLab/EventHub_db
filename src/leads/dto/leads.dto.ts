import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { LEAD_RATINGS, type LeadRating } from '../entities/booth-lead.entity';

export class ScanLeadDto {
  /** What the camera read from the badge or the app's ticket screen: `PICT1.<ticket>.<signature>`. */
  @ApiProperty({ example: 'PICT1.<ticket id>.<signature>' })
  @IsString()
  @MaxLength(200)
  qr: string;
}

export class UpdateLeadDto {
  @ApiPropertyOptional({ maxLength: 1000, nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(1000)
  note?: string | null;

  @ApiPropertyOptional({ enum: LEAD_RATINGS, nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn(LEAD_RATINGS)
  rating?: LeadRating | null;
}
