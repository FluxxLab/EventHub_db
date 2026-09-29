import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';

export class IngestStreamDto {
  @ApiPropertyOptional({
    enum: ['rtmp', 'whip'],
    description:
      'rtmp (default): RTMPS, which every encoder speaks. whip: WebRTC, from OBS 30+; skips transcoding.',
  })
  @IsOptional()
  @IsIn(['rtmp', 'whip'])
  input?: 'rtmp' | 'whip';

  @ApiPropertyOptional({
    description: 'Label speakers (panels). Default true.',
  })
  @IsOptional()
  @IsBoolean()
  diarise?: boolean;
}
