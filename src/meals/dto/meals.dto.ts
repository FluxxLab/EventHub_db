import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import {
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';

export class CreateMealDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  editionId: string;

  @ApiProperty({ example: 'Lunch, Day 1', maxLength: 120 })
  @IsString()
  @Length(1, 120)
  name: string;

  @ApiProperty({ description: 'When serving starts, ISO 8601 with offset' })
  @IsDateString()
  startsAt: string;

  @ApiProperty({ description: 'When serving ends' })
  @IsDateString()
  endsAt: string;
}

export class UpdateMealDto extends PartialType(
  OmitType(CreateMealDto, ['editionId'] as const),
) {}

export class CreateCounterDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  editionId: string;

  @ApiProperty({ example: 'Lunch counter, Hall B', maxLength: 120 })
  @IsString()
  @Length(1, 120)
  name: string;
}

export class ServeDto {
  @ApiProperty({ format: 'uuid', description: 'The meal being served' })
  @IsUUID()
  mealId: string;

  @ApiPropertyOptional({ description: 'The scanned ticket QR (PICT1.…)' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  qr?: string;

  @ApiPropertyOptional({
    description: 'Or the ticket code typed in, e.g. PIC-VIP-3QX7',
  })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  code?: string;
}
