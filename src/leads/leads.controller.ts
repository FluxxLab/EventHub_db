import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/strategies/jwt.stategies';
import { Audit } from '../common/decorators/audit.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { EditionScoped } from '../common/edition-scope/edition-scope.decorator';
import { ThrottleBoothScanner } from '../common/throttle/throttle.decorators';
import { AccessTier } from '../delegate/entities/delegate.entity';
import { ScanLeadDto, UpdateLeadDto } from './dto/leads.dto';
import { LeadsService } from './leads.service';

/** The header the exhibitor scanner page sends: `<booth id>.<secret>` from the booth's private link. */
export const BOOTH_KEY_HEADER = 'x-booth-key';

/** Organisers: scanner links for stands, and every lead of an edition. */
@ApiTags('leads')
@Controller()
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Post('booths/:id/lead-link')
  @HttpCode(200)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'booth' })
  @Audit({
    type: 'lead_link_created',
    description: 'Lead scanner link made for a stand',
  })
  @ApiOperation({
    summary:
      "A new private scanner link for the stand's staff; any earlier link stops working. Shown once.",
  })
  issue(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.leads.issueKey(id, user.id);
  }

  @Delete('booths/:id/lead-link')
  @HttpCode(204)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'booth' })
  @Audit({
    type: 'lead_link_revoked',
    description: 'Lead scanner link revoked',
  })
  @ApiOperation({ summary: "Stop the stand's scanner link working" })
  async revoke(@Param('id', ParseUUIDPipe) id: string) {
    await this.leads.revokeKey(id);
  }

  @Get('editions/:editionId/leads/summary')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'editionId' })
  @ApiOperation({
    summary: 'Leads per stand, and which stands have a scanner link',
  })
  summary(@Param('editionId', ParseUUIDPipe) editionId: string) {
    return this.leads.summary(editionId);
  }

  @Get('editions/:editionId/leads')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'editionId' })
  @Audit({ type: 'leads_exported', description: 'Exhibition leads exported' })
  @ApiOperation({
    summary: "Every stand's leads, with contact details, for export",
  })
  all(@Param('editionId', ParseUUIDPipe) editionId: string) {
    return this.leads.editionLeads(editionId);
  }
}

/**
 * The stand's scanner page. No account: the private link's key, sent as a
 * header, says which stand it is. Rate-limited per key, so one stand
 * scanning fast never uses up the venue's shared IP.
 */
@ApiTags('leads')
@ApiHeader({
  name: BOOTH_KEY_HEADER,
  description: 'The key from the stand’s private link',
})
@Controller('exhibitor')
export class ExhibitorController {
  constructor(private readonly leads: LeadsService) {}

  @Get()
  @Public()
  @ThrottleBoothScanner()
  @ApiOperation({ summary: 'The stand, its event and its leads so far' })
  async view(@Headers(BOOTH_KEY_HEADER) key: string | undefined) {
    return this.leads.exhibitorView(await this.leads.boothForKey(key));
  }

  @Post('scan')
  @HttpCode(200)
  @Public()
  @ThrottleBoothScanner()
  @ApiOperation({
    summary:
      "Record the delegate whose badge was scanned as the stand's lead; a repeat scan answers the lead already there",
  })
  async scan(
    @Headers(BOOTH_KEY_HEADER) key: string | undefined,
    @Body() dto: ScanLeadDto,
  ) {
    return this.leads.scan(await this.leads.boothForKey(key), dto.qr);
  }

  @Patch('leads/:id')
  @Public()
  @ThrottleBoothScanner()
  @ApiOperation({ summary: 'Note or rate a lead' })
  async update(
    @Headers(BOOTH_KEY_HEADER) key: string | undefined,
    @Param('id') id: string,
    @Body() dto: UpdateLeadDto,
  ) {
    return this.leads.update(await this.leads.boothForKey(key), id, dto);
  }

  @Delete('leads/:id')
  @HttpCode(204)
  @Public()
  @ThrottleBoothScanner()
  @ApiOperation({ summary: 'Remove a lead scanned by mistake' })
  async remove(
    @Headers(BOOTH_KEY_HEADER) key: string | undefined,
    @Param('id') id: string,
  ) {
    await this.leads.remove(await this.leads.boothForKey(key), id);
  }
}
