import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsString,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ForgotPasswordDto {
  @ApiProperty({ example: 'delegate@example.org' })
  @IsEmail()
  email: string;
}

export class ResetPasswordDto {
  @ApiProperty({ example: 'delegate@example.org' })
  @IsEmail()
  email: string;

  @ApiProperty({ description: 'The 6-digit code from the reset email' })
  @IsString()
  @Length(6, 6)
  otp: string;

  /** Same rules as registration - a reset must not become the weak way in. */
  @ApiProperty({ minLength: 8, maxLength: 255 })
  @IsString()
  @MinLength(8)
  @MaxLength(255)
  newPassword: string;
}
