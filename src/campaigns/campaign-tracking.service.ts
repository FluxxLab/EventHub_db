import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Records opens and clicks. Each person counts once towards a campaign's
 * opened and clicked figures however often they open or click; a click
 * also counts as an open (their mail app may block images). The person's
 * row is locked first, so two requests at once cannot both count as "first".
 */
@Injectable()
export class CampaignTracking {
  constructor(private readonly dataSource: DataSource) {}

  async opened(recipientId: string): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      const [row]: { campaignId: string; openedAt: Date | null }[] =
        await m.query(
          `SELECT "campaignId", "openedAt" FROM email_campaign_recipients WHERE id = $1 FOR UPDATE`,
          [recipientId],
        );
      if (!row) return;
      await m.query(
        `UPDATE email_campaign_recipients SET opens = opens + 1, "openedAt" = COALESCE("openedAt", now()) WHERE id = $1`,
        [recipientId],
      );
      if (!row.openedAt) {
        await m.query(
          `UPDATE email_campaigns SET opened = opened + 1 WHERE id = $1`,
          [row.campaignId],
        );
      }
    });
  }

  async clicked(recipientId: string, url: string): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      const [row]: {
        campaignId: string;
        openedAt: Date | null;
        clickedAt: Date | null;
      }[] = await m.query(
        `SELECT "campaignId", "openedAt", "clickedAt" FROM email_campaign_recipients WHERE id = $1 FOR UPDATE`,
        [recipientId],
      );
      if (!row) return;
      await m.query(
        `UPDATE email_campaign_recipients
            SET clicks = clicks + 1, "clickedAt" = COALESCE("clickedAt", now()), "openedAt" = COALESCE("openedAt", now())
          WHERE id = $1`,
        [recipientId],
      );
      if (!row.clickedAt || !row.openedAt) {
        await m.query(
          `UPDATE email_campaigns SET clicked = clicked + $2::int, opened = opened + $3::int WHERE id = $1`,
          [row.campaignId, row.clickedAt ? 0 : 1, row.openedAt ? 0 : 1],
        );
      }
      await m.query(
        `INSERT INTO email_campaign_links ("campaignId", url, clicks)
         VALUES ($1, $2, 1)
         ON CONFLICT ("campaignId", url) DO UPDATE SET clicks = email_campaign_links.clicks + 1`,
        [row.campaignId, url.slice(0, 500)],
      );
    });
  }

  /** A campaign's links, most clicked first. */
  links(campaignId: string): Promise<{ url: string; clicks: number }[]> {
    return this.dataSource.query(
      `SELECT url, clicks FROM email_campaign_links WHERE "campaignId" = $1 ORDER BY clicks DESC, url LIMIT 20`,
      [campaignId],
    );
  }
}
