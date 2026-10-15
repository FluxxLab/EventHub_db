import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { AVATAR_CONTENT_TYPES } from '../../delegate/dto/avatar-upload.dto';
import { EDITION_LOGO_FOLDER } from './edition-logo.dto';

/**
 * An event's brand kit beside its logo and colour: the logo drawn for dark
 * backgrounds, and the brand guide (a PDF) the call-to-action decks are
 * designed from.
 */
export const BRAND_ASSETS = ['logo-dark', 'guide'] as const;
export type BrandAsset = (typeof BRAND_ASSETS)[number];

/** Where brand guides live in the bucket; dark logos share the logos' folder. */
export const EDITION_GUIDE_FOLDER = 'edition-brand-guides';

export const BRAND_ASSET_FOLDER: Record<BrandAsset, string> = {
  'logo-dark': EDITION_LOGO_FOLDER,
  guide: EDITION_GUIDE_FOLDER,
};

/** What each may be uploaded as. */
export const BRAND_ASSET_TYPES: Record<BrandAsset, readonly string[]> = {
  'logo-dark': AVATAR_CONTENT_TYPES,
  guide: ['application/pdf'],
};

/** A key minted for that asset's folder (so replacing it can only ever delete its own upload). */
export const brandAssetPattern = (asset: BrandAsset) =>
  new RegExp(`^${BRAND_ASSET_FOLDER[asset]}/[0-9a-f-]{36}$`, 'i');

export class BrandUploadDto {
  @ApiProperty({ example: 'application/pdf' })
  @IsIn([...new Set(Object.values(BRAND_ASSET_TYPES).flat())])
  contentType: string;
}

export class SetBrandAssetDto {
  @ApiProperty({
    maxLength: 512,
    description:
      'The `key` returned by POST /editions/:id/brand-upload/:asset, after the PUT to storage succeeded',
  })
  @IsString()
  @MaxLength(512)
  @Matches(/^[\w-]+\/[0-9a-f-]{36}$/i)
  key: string;

  @ApiProperty({
    required: false,
    maxLength: 255,
    description: "The guide's file name, to show in the console",
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;
}
