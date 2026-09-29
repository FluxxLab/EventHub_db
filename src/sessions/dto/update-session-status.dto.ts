import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { SessionStatus } from '../entities/session.entity';

export class UpdateSessionStatusDto {
  @ApiProperty({ enum: SessionStatus })
  @IsEnum(SessionStatus)
  status: SessionStatus;
}
