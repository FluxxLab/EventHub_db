import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class AgendaCheckDto {
  @ApiProperty({ minimum: 1, example: 1 })
  @IsInt()
  @Min(1)
  @Max(14)
  day: number;

  @ApiProperty({ example: 'Main Hall' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  room: string;
}
