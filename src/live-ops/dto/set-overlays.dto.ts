import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class setOverlaysDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  captions?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  signLanguage?: boolean;

  @ApiProperty({ description: 'ID of the session' })
  @IsString()
  @IsNotEmpty()
  sessionId: string;
}
