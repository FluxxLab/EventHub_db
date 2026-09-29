import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** Rows per call: the console sends a big spreadsheet in batches of this. */
export const ISSUE_BATCH_LIMIT = 500;

export class IssueTicketRowDto {
  @ApiProperty({ example: 'Ngozi Eze' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name: string;

  @ApiProperty({ example: 'ngozi@example.com' })
  @IsEmail()
  @MaxLength(255)
  email: string;

  @ApiProperty({ description: "One of the edition's ticket types" })
  @IsUUID()
  ticketTypeId: string;

  @ApiPropertyOptional({ example: 'Women in Policy Africa' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  organisation?: string;

  @ApiPropertyOptional({ example: 'Programme Director' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  title?: string;

  @ApiPropertyOptional({ example: 'Nigeria' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;
}

export class IssueTicketsDto {
  @ApiProperty({ type: [IssueTicketRowDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(ISSUE_BATCH_LIMIT)
  @ValidateNested({ each: true })
  @Type(() => IssueTicketRowDto)
  rows: IssueTicketRowDto[];

  @ApiProperty({
    description: 'Email each person their ticket once it is issued',
  })
  @IsBoolean()
  notify: boolean;
}
