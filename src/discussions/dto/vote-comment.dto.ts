import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { VoteValue } from '../entities/comment-vote.entity';

export class VoteCommentDto {
  /**
   * null clears the delegate's vote. Sending the value they already hold is
   * treated the same way by the client (tapping Like twice), but the clear is
   * explicit here so the server never has to guess at a toggle.
   */
  @ApiProperty({
    enum: [...Object.values(VoteValue), null],
    nullable: true,
    description: "'like', 'dislike', or null to clear the vote",
  })
  @IsIn([...Object.values(VoteValue), null])
  value: VoteValue | null;
}
