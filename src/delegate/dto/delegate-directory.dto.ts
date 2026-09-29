import { ApiProperty } from '@nestjs/swagger';
import { AccessTier } from '../entities/delegate.entity';

export class DelegateDirectoryDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Fatima Bello' })
  name: string;

  @ApiProperty({ example: 'African Development Bank', nullable: true })
  organisation: string | null;

  @ApiProperty({ example: 'Nigeria', nullable: true })
  country: string | null;

  @ApiProperty({ enum: AccessTier, example: AccessTier.STANDARD })
  accessTier: AccessTier;

  @ApiProperty({ example: 'Climate Policy Advisor', nullable: true })
  title: string | null;

  @ApiProperty({ example: 'energy', nullable: true })
  track: string | null;

  @ApiProperty({ type: [String], example: ['keynote', 'roundtable-a'] })
  tags: string[];

  @ApiProperty({ type: [String], example: ['energy', 'food-systems'] })
  tracks: string[];

  @ApiProperty({
    nullable: true,
    description: 'Profile photo uploaded by the delegate',
  })
  avatarUrl: string | null;

  @ApiProperty({
    required: false,
    description:
      'Only set on the single-delegate lookup: true when the delegate is still awaiting admin review, so clients can label the profile and expect /connect to be refused.',
  })
  pendingReview?: boolean;

  @ApiProperty({
    required: false,
    nullable: true,
    maxLength: 280,
    description:
      'Only set on the single-delegate lookup: their short "about me". Null when they have none, or are hidden from the directory (except to themselves).',
  })
  bio?: string | null;
}

/** One delegate's online status (GET /delegates/presence, socket presence:update). */
export class PresenceDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    description:
      'False also when you may not see this delegate (hidden from the directory, or a block either way)',
  })
  online: boolean;

  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'When they were last connected; null while online or unknown',
  })
  lastSeenAt: string | null;
}
