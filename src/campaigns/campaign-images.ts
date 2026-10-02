import type { StorageService } from '../common/storage/storage.service';
import type { CampaignImages } from './campaign-email';
import type { EmailCampaign } from './entities/email-campaign.entity';
import type { TrackingLinks } from './tracking-links';

export const CAMPAIGN_IMAGE_PARTS = ['logo', 'banner'] as const;
export type CampaignImagePart = (typeof CAMPAIGN_IMAGE_PARTS)[number];

/** Signed reads in an email outlive the send this long when there is no API address to link through. */
const FALLBACK_SECONDS = 6 * 24 * 3600;

/**
 * Where a campaign's pictures load from in the emails it sends. With
 * PUBLIC_API_URL set, through the API (`/email/img/...`), which signs a fresh
 * read every time a mail app fetches one, so the pictures keep working
 * however late the email is opened. The query carries the end of the key so
 * a picture changed between two test sends is not served from a mail app's
 * cache. Without it, a signed read that lasts six days.
 */
export async function campaignImages(
  campaign: Pick<EmailCampaign, 'id' | 'design'>,
  tracking: Pick<TrackingLinks, 'apiUrl'>,
  storage: Pick<StorageService, 'presignRead'>,
): Promise<CampaignImages> {
  const api = tracking.apiUrl();
  const url = async (part: CampaignImagePart): Promise<string | null> => {
    const key = campaign.design?.[part];
    if (!key) return null;
    if (api)
      return `${api}/email/img/${campaign.id}/${part}?v=${encodeURIComponent(key.slice(-8))}`;
    return storage.presignRead(key, FALLBACK_SECONDS).catch(() => null);
  };
  const [logo, banner] = await Promise.all([url('logo'), url('banner')]);
  return { logo, banner };
}
