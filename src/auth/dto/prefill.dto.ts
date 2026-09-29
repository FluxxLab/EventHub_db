import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class PrefillQueryDto {
  @ApiProperty({ description: 'Printed invite code', example: 'A1B2C3D4' })
  @IsString()
  @Length(1, 50)
  code: string;
}

/** What the sign-up form can fill in before the invitee types anything. */
export interface RegistrationPrefill {
  email: string | null;
  name: string | null;
  organisation: string | null;
  title: string | null;
}
