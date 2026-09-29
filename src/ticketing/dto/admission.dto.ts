import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class AdmitTicketDto {
  /** The scanned payload, `PICT1.<ticketId>.<signature>`. */
  @IsString()
  @MaxLength(200)
  qr: string;

  /** The event this gate is for; a ticket for another event is refused. */
  @IsOptional()
  @IsUUID()
  editionId?: string;
}

export class FindTicketDto {
  /** The event this desk is for. */
  @IsUUID()
  editionId: string;

  /** A ticket code, or part of an email or name. */
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  query: string;
}

/** One page of the offline gate manifest. */
export class AdmissionManifestQueryDto {
  /** The last ticket id of the previous page; omit for the first page. */
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2000)
  limit?: number;
}

/** One scan the gate phone made while it had no signal. */
export class AdmitBatchItemDto {
  /** The scanned payload, `PICT1.<ticketId>.<signature>`. */
  @IsString()
  @MaxLength(200)
  qr: string;

  /** When the phone scanned it (ISO 8601); recorded as the admission time. */
  @IsISO8601()
  scannedAt: string;

  /** The id the phone gave this scan; re-sending it admits nobody twice. */
  @IsUUID()
  clientId: string;

  /** Which gate phone scanned it. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9_-]+$/)
  deviceId?: string;
}

/** Offline scans uploaded once the gate phone is back online. */
export class AdmitBatchDto {
  /** The event this gate is for; every scan is checked against it. */
  @IsUUID()
  editionId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AdmitBatchItemDto)
  items: AdmitBatchItemDto[];
}
