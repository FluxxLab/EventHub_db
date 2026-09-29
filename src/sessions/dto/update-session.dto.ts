import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateSessionDto } from './create-session.dto';

export class UpdateSessionDto extends PartialType(CreateSessionDto) {
  /**
   * One room holds one session at a time. When this edit would land on a
   * later session in the same room and day, push that session - and any it
   * lands on in turn - just far enough to start when the previous one ends,
   * so a keynote pushed back 20 minutes is one edit, not six. On by
   * default. Send false to have a collision refused (409) naming the session
   * in the way instead of moved.
   */
  @ApiPropertyOptional({
    description:
      'Push later sessions in this room and day out of the way if this edit would overlap them (default). Send false to have a collision refused instead',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  shiftFollowing?: boolean;
}
