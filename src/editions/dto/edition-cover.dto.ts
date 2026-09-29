import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';

/** Where uploaded edition covers live in the bucket. */
export const EDITION_COVER_FOLDER = 'edition-covers';

/**
 * A key minted by `POST /editions/:id/cover-upload`, or an https URL for
 * artwork hosted elsewhere. Anything else is refused, so a cover can never
 * point at another folder's object (a delegate photo, a certificate) and have
 * it deleted when the cover is replaced.
 */
export const EDITION_COVER_PATTERN = new RegExp(
  `^(${EDITION_COVER_FOLDER}/[0-9a-f-]{36}|https://\\S+)$`,
  'i',
);

export class SetEditionCoverDto {
  @ApiProperty({
    maxLength: 512,
    example: 'edition-covers/7d3c2f0e-5b1a-4c55-9a0e-2f9c7a1b6d44',
    description:
      'The `key` returned by POST /editions/:id/cover-upload (after the PUT to S3 succeeded), or an https URL',
  })
  @IsString()
  @MaxLength(512)
  @Matches(EDITION_COVER_PATTERN, {
    message: 'coverImage must be an uploaded cover key or an https URL',
  })
  coverImage: string;
}
