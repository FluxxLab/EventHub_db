import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class VerifyPassDto {
  /**
   * Bounded because this arrives from a camera pointed at whatever someone
   * chose to put on a screen, and an unbounded string is a free ride into the
   * JWT parser.
   */
  @ApiProperty({ description: 'The scanned pass token', maxLength: 2048 })
  @IsString()
  @MaxLength(2048)
  pass: string;
}
