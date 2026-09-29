import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, MaxLength } from 'class-validator';

export class RegisterDeviceDto {
  @ApiProperty({
    maxLength: 512,
    description: 'FCM registration token from the mobile app',
  })
  @IsString()
  @MaxLength(512)
  token: string;

  @ApiProperty({ enum: ['ios', 'android'] })
  @IsIn(['ios', 'android'])
  platform: string;
}
