import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';

/** Where uploaded edition logos live in the bucket. */
export const EDITION_LOGO_FOLDER = 'edition-logos';

/**
 * A key minted by `POST /editions/:id/logo-upload`, or an https URL. The same
 * rule as covers: a logo can never point at another folder's object and have
 * it deleted when the logo is replaced.
 */
export const EDITION_LOGO_PATTERN = new RegExp(
  `^(${EDITION_LOGO_FOLDER}/[0-9a-f-]{36}|https://\\S+)$`,
  'i',
);

/** An event's button colour: six-digit hex, like `#0f6b3a`. */
export const BRAND_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

export class SetEditionLogoDto {
  @ApiProperty({
    maxLength: 512,
    example: 'edition-logos/7d3c2f0e-5b1a-4c55-9a0e-2f9c7a1b6d44',
    description:
      'The `key` returned by POST /editions/:id/logo-upload (after the PUT to S3 succeeded), or an https URL',
  })
  @IsString()
  @MaxLength(512)
  @Matches(EDITION_LOGO_PATTERN, {
    message: 'logoImage must be an uploaded logo key or an https URL',
  })
  logoImage: string;
}
