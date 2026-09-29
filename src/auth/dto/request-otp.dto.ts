import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsPhoneNumber, ValidateIf } from 'class-validator';
import { normalisePhone } from '../../common/phone';

export class RequestOtpDto {
  @ApiProperty()
  @IsEmail()
  email: string;

  @ApiProperty({
    enum: ['email', 'sms'],
    description: 'where to send the code -delegates code',
  })
  @IsIn(['email', 'sms'])
  channel: 'email' | 'sms';

  @ApiPropertyOptional({
    example: '+2349035374708',
    description: 'required when channel is sms ',
  })
  @ValidateIf((o) => o.channel === 'sms')
  // 'NG' so a local 11-digit number parses; the transform above has already
  // turned it into +234..., and a number from anywhere else still validates
  @Transform(({ value }) =>
    typeof value === 'string' ? normalisePhone(value) : value,
  )
  @IsPhoneNumber('NG')
  phone?: string;
}
