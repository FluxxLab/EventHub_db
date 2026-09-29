import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

/**
 * Documents are PDFs. This used to reuse AvatarUploadDto, whose whitelist is
 * images only, so every Purple Book upload was rejected with "contentType must
 * be one of image/jpeg, image/png, image/webp, image/heic".
 *
 * The signed URL is bound to this value, so a client that lies here cannot
 * complete the upload.
 */
export const DOCUMENT_CONTENT_TYPES = ['application/pdf'] as const;

export class DocumentUploadDto {
  @ApiProperty({ enum: DOCUMENT_CONTENT_TYPES, example: 'application/pdf' })
  @IsIn(DOCUMENT_CONTENT_TYPES)
  contentType: string;
}
