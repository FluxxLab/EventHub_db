import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { Audit } from '../../common/decorators/audit.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AccessTier } from '../../delegate/entities/delegate.entity';
import { EventSeverity } from '../../security/entities/security-event.entity';
import { IngestStreamDto } from './dto/ingest.dto';
import { IngestService } from './ingest.service';
import { EditionScoped } from '../../common/edition-scope/edition-scope.decorator';

/**
 * Venue streams: each room's audio from the venue mixer, captioned without a
 * capture desk. Under /ingest rather than /captions, whose GET /:sessionId
 * would otherwise take GET /captions/ingress for a session id.
 */
@ApiTags('captions')
@ApiBearerAuth()
@Controller('ingest')
export class IngestController {
  constructor(private readonly ingest: IngestService) {}

  @Get('rooms')
  @Roles(AccessTier.ADMIN, AccessTier.SESSION_ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'current' })
  @ApiOperation({
    summary:
      "The venue's rooms with their stream (state, input, URL - never the key) and who is captioning each",
  })
  @ApiResponse({ status: 503, description: 'Venue streams not enabled' })
  rooms() {
    return this.ingest.list();
  }

  @Post('rooms/:room')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'current' })
  @Audit({
    type: 'ingest_created',
    description: 'Venue stream created for a room',
    severity: EventSeverity.WARNING,
  })
  @ApiOperation({
    summary:
      "Create a room's stream. Returns the URL and stream key, which are shown only here and on rotate.",
  })
  @ApiResponse({ status: 400, description: "Not one of the venue's rooms" })
  @ApiResponse({ status: 409, description: 'The room already has a stream' })
  create(@Param('room') room: string, @Body() dto: IngestStreamDto) {
    return this.ingest.create(room, dto.input ?? 'rtmp', dto.diarise ?? true);
  }

  @Post('rooms/:room/rotate')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'current' })
  @Audit({
    type: 'ingest_rotated',
    description: 'Venue stream key rotated',
    severity: EventSeverity.WARNING,
  })
  @ApiOperation({
    summary:
      "Replace a room's stream key (and optionally its input or speaker labels). The old key stops working at once.",
  })
  rotate(@Param('room') room: string, @Body() dto: IngestStreamDto) {
    return this.ingest.rotate(room, dto.input, dto.diarise);
  }

  @Delete('rooms/:room')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'current' })
  @HttpCode(204)
  @Audit({
    type: 'ingest_deleted',
    description: 'Venue stream removed',
    severity: EventSeverity.WARNING,
  })
  @ApiOperation({ summary: "Remove a room's stream" })
  async remove(@Param('room') room: string) {
    await this.ingest.remove(room);
  }
}

@ApiTags('captions')
@Controller('livekit')
export class LivekitWebhookController {
  constructor(private readonly ingest: IngestService) {}

  @Public()
  @Post('webhook')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'LiveKit webhook (signed JWT in Authorization; acts on ingress_started / ingress_ended)',
  })
  @ApiResponse({ status: 401, description: 'Bad signature' })
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('authorization') authorization?: string,
  ) {
    await this.ingest.webhook(
      req.rawBody?.toString('utf8') ?? '',
      authorization,
    );
    return { ok: true };
  }
}
