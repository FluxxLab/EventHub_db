import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { StorageService } from '../common/storage/storage.service';
import {
  CAMPAIGN_IMAGE_PARTS,
  type CampaignImagePart,
} from './campaign-images';
import { CampaignsService } from './campaigns.service';
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
    private readonly campaigns: CampaignsService,
    private readonly storage: StorageService,
  ) {}

  /**
   * A campaign's logo or banner, as its emails link it: a redirect to a
   * freshly signed read, so a picture still loads in an email opened weeks
   * later. Public, like the email itself; the pictures are not secret.
   */
  @Get('img/:id/:part')
  @Public()
  async image(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('part') part: string,
    @Res() res: Response,
  ) {
    const key = (CAMPAIGN_IMAGE_PARTS as readonly string[]).includes(part)
      ? await this.campaigns.pictureKey(id, part as CampaignImagePart)
      : null;
    if (!key) throw new NotFoundException('No such picture');
    const url = await this.storage.presignRead(key);
    // mail apps and their image proxies may keep it a while; the signed read outlives that
    res.set('Cache-Control', 'public, max-age=1800').redirect(302, url);
  }

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
