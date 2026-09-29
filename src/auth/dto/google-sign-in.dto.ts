import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class GoogleSignInDto {
  @ApiProperty({
    description: 'The ID token from Google sign-in on the device',
  })
  @IsString()
  @MaxLength(4096)
  idToken: string;

  @ApiPropertyOptional({
    description:
      'Consent to the registration terms. Needed (true) only when this sign-in creates or claims an account; without it the API answers 400 with code consent_required.',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  consent?: boolean;
}
