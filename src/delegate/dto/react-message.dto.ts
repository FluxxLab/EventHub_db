import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class ReactMessageDto {
  /**
   * The emoji to apply, or null to clear the caller's reaction.
   *
   * Not restricted to a fixed set: the client offers a short picker, but a
   * whitelist here would have to be kept in sync with the app forever, and a
   * mismatch would reject a reaction the delegate could plainly see offered.
   * Length is capped instead - one emoji, allowing for skin tone and ZWJ
   * sequences, which is what the 16-char column stores.
   */
  @ApiProperty({
    nullable: true,
    description: 'Emoji to apply, or null to remove the reaction',
    example: '👍',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(16)
  emoji!: string | null;
}
