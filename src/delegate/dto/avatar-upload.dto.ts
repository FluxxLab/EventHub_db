import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

// Only image types the app can render, and only ones S3 will serve back with a
// sensible Content-Type. The signed URL is bound to this value, so a client that
// lies here cannot complete the upload.
export const AVATAR_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
] as const;

export class AvatarUploadDto {
  @ApiProperty({ enum: AVATAR_CONTENT_TYPES, example: 'image/jpeg' })
  @IsIn(AVATAR_CONTENT_TYPES)
  contentType: string;
}
