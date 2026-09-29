import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/strategies/jwt.stategies';
import { Audit } from '../common/decorators/audit.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { EditionScoped } from '../common/edition-scope/edition-scope.decorator';
import { AccessTier } from '../delegate/entities/delegate.entity';
import { CampaignTracking } from './campaign-tracking.service';
import { CampaignsService } from './campaigns.service';
import { AudienceSizeDto, SaveCampaignDto } from './dto/campaign.dto';

/** Email campaigns to an edition's ticket holders, for admins and that edition's organisers. */
@ApiTags('campaigns')
@ApiBearerAuth()
@Controller()
export class CampaignsController {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly tracking: CampaignTracking,
  ) {}

  @Get('campaigns/:id/links')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'campaign' })
  @ApiOperation({ summary: "A sent campaign's links, most clicked first" })
  links(@Param('id', ParseUUIDPipe) id: string) {
    return this.tracking.links(id);
  }

  @Get('editions/:id/campaigns')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @ApiOperation({ summary: "An edition's email campaigns, newest first" })
  list(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.list(id);
  }

  @Post('editions/:id/campaigns')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @Audit({ type: 'campaign_created', description: 'Email campaign drafted' })
  @ApiOperation({ summary: 'Save a new campaign as a draft' })
  create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveCampaignDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.campaigns.create(id, user.id, dto);
  }

  @Post('editions/:id/campaigns/audience-size')
  @HttpCode(200)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @ApiOperation({ summary: 'How many ticket holders an audience reaches now' })
  audienceSize(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AudienceSizeDto,
  ) {
    return this.campaigns.audienceSize(id, dto.audience);
  }

  @Patch('campaigns/:id')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'campaign' })
  @Audit({ type: 'campaign_updated', description: 'Email campaign edited' })
  @ApiOperation({ summary: 'Edit a draft campaign' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveCampaignDto) {
    return this.campaigns.update(id, dto);
  }

  @Delete('campaigns/:id')
  @HttpCode(204)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'campaign' })
  @Audit({ type: 'campaign_deleted', description: 'Email campaign deleted' })
  @ApiOperation({ summary: 'Delete a draft campaign' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.campaigns.remove(id);
  }

  @Post('campaigns/:id/test')
  @HttpCode(200)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'campaign' })
  @ApiOperation({
    summary: 'Email the campaign to yourself, as recipients will see it',
  })
  test(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.campaigns.sendTest(id, user.id);
  }

  @Post('campaigns/:id/send')
  @HttpCode(200)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'campaign' })
  @Audit({ type: 'campaign_sent', description: 'Email campaign sent' })
  @ApiOperation({
    summary:
      'Send the campaign: the audience is fixed now and emailed in the background',
  })
  send(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.campaigns.send(id, user.id);
  }
}
