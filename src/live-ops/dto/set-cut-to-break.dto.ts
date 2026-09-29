import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsString } from 'class-validator';

export class SetCutToBreakDto {
  @ApiProperty({ description: 'true = cut stream to break screen' })
  @IsBoolean()
  active: boolean;

  @ApiProperty({ description: 'ID of the session' })
  @IsString()
  @IsNotEmpty()
  sessionId: string;
}
