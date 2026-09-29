import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { CampaignTracking } from './campaign-tracking.service';
import { TrackingLinks } from './tracking-links';

/** A transparent 1×1 GIF. */
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

/**
 * The open image and the click redirect in campaign emails. Both always
 * answer as the mail app expects (an image, a redirect to where the email
 * linked) even when recording fails: tracking must never break an email.
 */
@ApiExcludeController()
@Controller('email')
export class TrackingController {
  constructor(
    private readonly links: TrackingLinks,
    private readonly tracking: CampaignTracking,
  ) {}

  @Get('o/:token')
  @Public()
  async open(@Param('token') token: string, @Res() res: Response) {
    const id = this.links.verifyOpen(token);
    if (id) await this.tracking.opened(id).catch(() => undefined);
    res
      .set({
        'Content-Type': 'image/gif',
        'Cache-Control': 'no-store, max-age=0',
      })
      .send(PIXEL);
  }

  @Get('c/:token')
  @Public()
  async click(
    @Param('token') token: string,
    @Query('u') url: string | undefined,
    @Res() res: Response,
  ) {
    const id = this.links.verifyClick(token, url);
    if (!id || !url) {
      res
        .status(404)
        .send('This link is not complete. Open it again from the email.');
      return;
    }
    await this.tracking.clicked(id, url).catch(() => undefined);
    res.redirect(302, url);
  }
}
