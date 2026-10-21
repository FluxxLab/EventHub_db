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
import { Roles } from '../common/decorators/roles.decorator';
import { AccessTier } from '../delegate/entities/delegate.entity';
import { SetCutToBreakDto } from './dto/set-cut-to-break.dto';
import { setOverlaysDto } from './dto/set-overlays.dto';
import { LiveOpsService } from './live-ops.service';
import { SessionSwitchService } from './switch/session-switch.service';
import { Audit } from '../common/decorators/audit.decorator';
import { EditionScoped } from '../common/edition-scope/edition-scope.decorator';

@ApiTags('Live Ops')
@ApiBearerAuth()
@Controller('live-ops')
export class LiveOpsController {
  constructor(
    private readonly service: LiveOpsService,
    private readonly switches: SessionSwitchService,
  ) {}

  @Get('switch-suggestions')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN, AccessTier.SESSION_ADMIN)
  @EditionScoped({ from: 'current' })
  @ApiOperation({
    summary:
      "The AI's open suggestions that a room's next session has started or its live one ended, and how many were right today",
  })
  switchSuggestions() {
    return this.switches.list();
  }

  @Post('switch-suggestions/:id/accept')
  @HttpCode(200)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN, AccessTier.SESSION_ADMIN)
  @EditionScoped({ from: 'current' })
  @ApiOperation({ summary: 'The room was switched from this suggestion' })
  acceptSwitch(@Param('id', ParseUUIDPipe) id: string) {
    return this.switches.decide(id, 'accepted');
  }

  @Post('switch-suggestions/:id/dismiss')
  @HttpCode(200)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN, AccessTier.SESSION_ADMIN)
  @EditionScoped({ from: 'current' })
  @ApiOperation({ summary: 'Not yet: the suggestion was wrong' })
  dismissSwitch(@Param('id', ParseUUIDPipe) id: string) {
    return this.switches.decide(id, 'dismissed');
  }

  @Get('overview')
  @ApiOperation({
    summary: 'Current broadcast flags - delegate apps fetch this on launch',
  })
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN, AccessTier.SESSION_ADMIN)
  @EditionScoped({ from: 'current' })
  overview() {
    return this.service.overview();
  }

  @Post('cut-to-break')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN, AccessTier.SESSION_ADMIN)
  @EditionScoped({ from: 'current' })
  @Audit({
    type: 'cut-to-break',
    description: 'Cut stream to break - broadcast: flags',
  })
  @ApiOperation({ summary: 'Cut stream to break - broadcast: flags' })
  cutToBreak(@Body() dto: SetCutToBreakDto) {
    return this.service.setCutToBreak(dto.sessionId, dto.active);
  }

  @Get('flags')
  @ApiOperation({
    summary: 'Current broadcast flag for a specific session',
  })
  flags(@Query('sessionId') sessionId: string) {
    return this.service.getflags(sessionId);
  }

  @Post('set-overlays')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN, AccessTier.SESSION_ADMIN)
  @EditionScoped({ from: 'current' })
  @Audit({ type: 'overlays_changed', description: 'Stream overlays changed' })
  @ApiOperation({ summary: 'Toggle captions / sign-language overlays' })
  overlays(@Body() dto: setOverlaysDto) {
    return this.service.setOverlays(dto.sessionId, dto);
  }
}
