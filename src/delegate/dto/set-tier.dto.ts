import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { AccessTier } from '../entities/delegate.entity';

export class SetTierDto {
  @ApiProperty({
    enum: [
      AccessTier.STANDARD,
      AccessTier.VIP,
      AccessTier.VVIP,
      AccessTier.PRESS,
    ],
  })
  @IsIn([
    AccessTier.STANDARD,
    AccessTier.VIP,
    AccessTier.VVIP,
    AccessTier.PRESS,
  ])
  tier: AccessTier;
}
