import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

// Deletion is irreversible, so it is confirmed with the account password rather
// than a tap alone - a borrowed unlocked phone should not be able to do this.
export class DeleteAccountDto {
  @ApiProperty({ description: "The delegate's current password" })
  @IsString()
  @MinLength(1)
  password: string;
}
