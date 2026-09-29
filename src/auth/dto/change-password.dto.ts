import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @ApiProperty({ description: 'The password the delegate signs in with now' })
  @IsString()
  @MaxLength(255)
  currentPassword: string;

  /** Same rules as registration and reset. */
  @ApiProperty({ minLength: 8, maxLength: 255 })
  @IsString()
  @MinLength(8)
  @MaxLength(255)
  newPassword: string;
}
