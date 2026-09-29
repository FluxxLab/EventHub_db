import type { Gender } from '../delegate/entities/delegate.entity';
import type { ReportReason } from '../delegate/dto/report-delegate.dto';
import { EditionCategory } from '../editions/entities/edition.entity';

/** Wording for the profile's gender picker; the values are GENDERS. */
export const GENDER_LABELS: Record<Gender, string> = {
  female: 'Female',
  male: 'Male',
  'non-binary': 'Non-binary',
  undisclosed: 'Prefer not to say',
};

/** Wording for the report sheet; the values are REPORT_REASONS. */
export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  harassment: 'Harassment or abuse',
  spam: 'Spam or unwanted promotion',
  impersonation: 'Impersonation or fake profile',
  inappropriate: 'Inappropriate content',
  other: 'Something else',
};

/**
 * Tile labels for a category with no category_settings row. The migration
 * seeds the same words, so this only matters for a category added to the
 * enum before its row.
 */
export const DEFAULT_CATEGORY_LABELS: Record<EditionCategory, string> = {
  [EditionCategory.SUMMITS]: 'Summits',
  [EditionCategory.WORKSHOPS]: 'Workshops',
  [EditionCategory.ROUNDTABLES]: 'Roundtables',
  [EditionCategory.CONFERENCES]: 'Conferences',
  [EditionCategory.FELLOWSHIPS]: 'Fellowships',
  [EditionCategory.TRAINING]: 'Classes & Training',
  [EditionCategory.EXHIBITIONS]: 'Exhibitions',
  [EditionCategory.COMMUNITY]: 'Community Events',
};

/** S3 folder for category artwork uploads. */
export const CATEGORY_IMAGE_FOLDER = 'category-images';
