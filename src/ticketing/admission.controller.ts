import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/strategies/jwt.stategies';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AccessTier } from '../delegate/entities/delegate.entity';
import { AdmissionService } from './admission.service';
import {
  AdmissionManifestQueryDto,
  AdmitBatchDto,
  AdmitTicketDto,
  FindTicketDto,
} from './dto/admission.dto';
import { Audit } from '../common/decorators/audit.decorator';
import { EditionScoped } from '../common/edition-scope/edition-scope.decorator';

/**
 * Entrance gate. Staff with an admin or session-admin account scan ticket QRs
 * in the app; the delegate-facing ticket screen shows the QR.
 */
@ApiTags('ticketing')
@ApiBearerAuth()
@Controller()
export class AdmissionController {
  constructor(private readonly admission: AdmissionService) {}

  @Post('tickets/admit')
  @HttpCode(200)
  @Roles(AccessTier.ADMIN, AccessTier.SESSION_ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped(
    { from: 'body', key: 'qr', via: 'ticketCode' },
    { from: 'body', key: 'editionId' },
  )
  @ApiOperation({
    summary:
      'Admit one person on a scanned ticket QR at the entrance; no time window',
  })
  admit(@Body() dto: AdmitTicketDto, @CurrentUser() user: AuthUser) {
    return this.admission.admit(dto.qr, user.id, dto.editionId);
  }

  @Post('tickets/admit/batch')
  @HttpCode(200)
  @Roles(AccessTier.ADMIN, AccessTier.SESSION_ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'body', key: 'editionId' })
  @ApiOperation({
    summary:
      'Upload admissions a gate phone made offline; each is admitted at its scan time and comes back with what happened (admitted, duplicate, already_used, transferred, unknown, wrong_event). Safe to re-send',
  })
  admitBatch(@Body() dto: AdmitBatchDto, @CurrentUser() user: AuthUser) {
    // Not @Audit: the body is a list of door QRs, which the audit log must not hold. Every
    // admission row records the staff account, the phone and when it was uploaded.
    return this.admission.admitBatch(
      dto.items.map((item) => ({
        qr: item.qr,
        scannedAt: new Date(item.scannedAt),
        clientId: item.clientId,
        deviceId: item.deviceId,
      })),
      user.id,
      dto.editionId,
    );
  }

  @Get('editions/:id/admission-manifest')
  @Roles(AccessTier.ADMIN, AccessTier.SESSION_ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @Audit({
    type: 'admission_manifest_downloaded',
    description:
      'Offline gate manifest downloaded (ticket holders of an event)',
  })
  @ApiOperation({
    summary:
      'One page of the offline gate manifest: each ticket with a digest of its current QR (not the signature), holder name, tier and places used. Page with ?cursor=<nextCursor>',
  })
  manifest(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: AdmissionManifestQueryDto,
  ) {
    return this.admission.manifest(id, query.cursor, query.limit);
  }

  @Post('tickets/find')
  @HttpCode(200)
  @Roles(AccessTier.ADMIN, AccessTier.SESSION_ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'body', key: 'editionId' })
  @Audit({
    type: 'ticket_looked_up',
    description: 'Ticket looked up at a check-in desk',
  })
  @ApiOperation({
    summary:
      'Find tickets of an edition by code, email or name at a check-in desk; each comes with its door QR to admit with',
  })
  find(@Body() dto: FindTicketDto) {
    return this.admission.find(dto.editionId, dto.query);
  }

  @Get('editions/:id/admissions')
  @Roles(AccessTier.ADMIN, AccessTier.SESSION_ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @ApiOperation({ summary: 'How many people are through the gate' })
  summary(@Param('id', ParseUUIDPipe) id: string) {
    return this.admission.summary(id);
  }
}
