import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { CURRENCIES } from '../payment/payment-options';

export class CreateTicketTypeDto {
  @ApiProperty({ example: 'VIP', maxLength: 100 })
  @IsString()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({
    description: 'Whole naira; 0 is free; omit for by-invitation tiers',
    example: 25000,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  price?: number;

  @ApiPropertyOptional({
    description: `Whole units per currency (${CURRENCIES.join(', ')}); NGN mirrors \`price\``,
    example: { NGN: 15000, USD: 20, GHS: 250 },
  })
  @IsOptional()
  @IsObject()
  prices?: Record<string, number>;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  @ArrayMaxSize(20)
  perks?: string[];

  @ApiPropertyOptional({ example: 'VIP', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  section?: string;

  @ApiPropertyOptional({ description: 'Omit for unlimited' })
  @IsOptional()
  @IsInt()
  @Min(1)
  capacity?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class UpdateTicketTypeDto extends PartialType(CreateTicketTypeDto) {}

export class OrderLineDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  ticketTypeId: string;

  @ApiProperty({ minimum: 1, maximum: 10 })
  @IsInt()
  @Min(1)
  @Max(10)
  quantity: number;
}

export class QuoteOrderDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  editionId: string;

  @ApiProperty({ type: [OrderLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  lines: OrderLineDto[];

  @ApiPropertyOptional({ maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  voucherCode?: string;

  @ApiPropertyOptional({
    description:
      'ISO 3166-1 alpha-2 billing country; decides the currency. Defaults to NG.',
    example: 'NG',
  })
  @IsOptional()
  @IsString()
  @Length(2, 2)
  country?: string;
}

export class GuestDto {
  @ApiProperty({ maxLength: 255 })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiProperty()
  @IsEmail()
  email: string;

  @ApiPropertyOptional({ maxLength: 30 })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;
}

export class AttendeeDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  ticketTypeId: string;

  @ApiProperty({ maxLength: 255 })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiProperty()
  @IsEmail()
  email: string;
}

export class CreateOrderDto extends QuoteOrderDto {
  @ApiProperty({ type: GuestDto })
  @ValidateNested()
  @Type(() => GuestDto)
  guest: GuestDto;

  @ApiPropertyOptional({
    type: [AttendeeDto],
    description:
      'One entry per place: who each ticket is for. Each becomes its own ticket in that person’s account, created unclaimed if they have none.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AttendeeDto)
  attendees?: AttendeeDto[];
}

export class ApplyVoucherDto {
  @ApiProperty({
    maxLength: 50,
    description: 'Empty string removes the voucher',
  })
  @IsString()
  @MaxLength(50)
  code: string;
}

export class PayOrderDto {
  @ApiProperty({ enum: ['card', 'transfer', 'ussd', 'wallet'] })
  @IsIn(['card', 'transfer', 'ussd', 'wallet'])
  method: 'card' | 'transfer' | 'ussd' | 'wallet';
}
