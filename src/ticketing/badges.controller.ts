import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import type { AuthUser } from '../auth/strategies/jwt.stategies';
import { Audit } from '../common/decorators/audit.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { EditionScoped } from '../common/edition-scope/edition-scope.decorator';
import { AccessTier } from '../delegate/entities/delegate.entity';
import { BadgesService } from './badges.service';
import {
  BadgeArtworkUploadDto,
  BadgeListQueryDto,
  SaveBadgeDesignDto,
} from './dto/badge.dto';
import { ChangeTicketTierDto } from './dto/change-tier.dto';
import { IssueTicketsDto } from './dto/issue.dto';
import { IssueService } from './issue.service';

/** The organisers' own ticket tools: issuing tickets without payment, and badges. */
@Controller()
export class BadgesController {
  constructor(
    private readonly badges: BadgesService,
    private readonly issuer: IssueService,
  ) {}

  @Post('editions/:id/tickets/issue')
  @HttpCode(200)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @Audit({
    type: 'tickets_issued',
    description: 'Tickets issued without payment (import or complimentary)',
  })
  @ApiOperation({
    summary:
      'Issue tickets without payment: an imported attendee list, or one complimentary ticket. Skips anyone who already holds a ticket to the edition.',
  })
  issue(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: IssueTicketsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.issuer.issue(id, user.id, dto);
  }

  @Patch('tickets/:id/ticket-type')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'ticket' })
  @Audit({
    type: 'ticket_tier_changed',
    description: 'Ticket moved to another tier of its event',
  })
  @ApiOperation({
    summary:
      "Move a ticket to another tier of its event; the tiers' counts follow and its QR stays valid",
  })
  changeTier(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeTicketTierDto,
  ) {
    return this.issuer.changeTier(id, dto.ticketTypeId);
  }

  @Get('editions/:id/badge-design')
  // door staff print badges at check-in desks with it
  @Roles(AccessTier.ADMIN, AccessTier.SESSION_ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @ApiOperation({ summary: "An edition's badge design (null when none saved)" })
  design(@Param('id', ParseUUIDPipe) id: string) {
    return this.badges.design(id);
  }

  @Put('editions/:id/badge-design')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @Audit({ type: 'badge_design_saved', description: 'Badge design saved' })
  @ApiOperation({
    summary:
      "Save an edition's badge design: size, colours and what is printed",
  })
  saveDesign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveBadgeDesignDto,
  ) {
    return this.badges.saveDesign(id, dto);
  }

  @Post('editions/:id/badge-design/upload-url')
  @HttpCode(200)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @ApiOperation({
    summary:
      'Signed URL for badge artwork (PNG or JPG): PUT the file, then save the returned key with the design',
  })
  artworkUploadUrl(
    @Param('id', ParseUUIDPipe) _id: string,
    @Body() dto: BadgeArtworkUploadDto,
  ) {
    return this.badges.presignArtwork(dto.contentType);
  }

  @Get('editions/:id/badges')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @Audit({
    type: 'badges_listed',
    description: 'Badges with door QR codes fetched for printing',
  })
  @ApiOperation({
    summary:
      "The edition's ticket holders as badges, each with the ticket's signed door QR",
  })
  holders(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: BadgeListQueryDto,
  ) {
    return this.badges.holders(id, query.ticketTypeId);
  }
}
