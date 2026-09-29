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
  Query,
  ParseArrayPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AccessTier } from '../delegate/entities/delegate.entity';
import { BulkDeleteSessionsDto } from './dto/bulk-delete-sessions.dto';
import { CreateSessionDto } from './dto/create-session.dto';
import { QualityQueryDto } from './dto/quality-query.dto';
import { QuerySessionsDto } from './dto/query-sessions.dto';
import { UpdateSessionDto } from './dto/update-session.dto';
import { UpdateSessionStatusDto } from './dto/update-session-status.dto';
import { SessionsService } from './sessions.service';
import type { AuthUser } from '../auth/strategies/jwt.stategies';
import { Audit } from '../common/decorators/audit.decorator';
import { EditionScoped } from '../common/edition-scope/edition-scope.decorator';

@Controller('sessions')
@ApiBearerAuth()
@ApiTags('sessions')
export class SessionController {
  constructor(private readonly service: SessionsService) {}

  // Not @Public(): speakers are withheld until the organisers reveal them, and
  // that rule needs to know who is asking - a public handler has no user, so
  // admin could not be exempted from it. The redaction itself is applied by
  // SpeakerRevealInterceptor, not here.
  @Get()
  @ApiOperation({})
  list(@Query() query: QuerySessionsDto) {
    return this.service.list(query);
  }

  @Get('live')
  @ApiOperation({})
  liveNow() {
    return this.service.findLiveNow();
  }

  @Get('saved')
  @ApiOperation({})
  saved(@CurrentUser() user: AuthUser) {
    return this.service.savedSessions(user.id);
  }

  /**
   * The single source of truth for tracks.
   *
   * Declared before :id so the router does not try to parse "tracks" as a
   * UUID. Public because every client needs it before a delegate has logged
   * in, and because a hardcoded copy in each app is how the three of them
   * drifted apart - the database enum rejects anything not listed here, so a
   * client-side list that disagrees produces a 400 nobody can explain.
   */
  @Public()
  @Get('tracks')
  @ApiOperation({
    summary: 'Session tracks, as the database enum defines them',
  })
  tracks() {
    return this.service.tracks();
  }

  /**
   * The closed list of session types, for the console's picker and the
   * app's grouping. Same reasoning as tracks: public, and declared before
   * :id.
   */
  @Public()
  @Get('types')
  @ApiOperation({ summary: 'Session types the API accepts, with labels' })
  types() {
    return this.service.types();
  }

  /**
   * The data-quality audit the post-summit report asked for: sessions filed
   * under the general track, rooms still reading TBC, type spellings the
   * normaliser could not place, and sessions with nobody on stage.
   */
  @Get('quality')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'query', key: 'editionId' })
  @ApiOperation({
    summary:
      'Programme data quality: general track, placeholder rooms, type variants, missing speakers',
  })
  quality(@Query() query: QualityQueryDto) {
    return this.service.quality(query.editionId);
  }

  /**
   * The venue departures board. Public: it runs on a TV in the wings with no
   * one to log in, and it exposes nothing a printed programme does not.
   * Declared before :id for the same reason as tracks.
   */
  @Public()
  @Get('board')
  @ApiOperation({
    summary:
      'Every session with room, times and status, for a public venue screen',
  })
  board() {
    return this.service.board();
  }

  @Get(':id')
  @ApiOperation({})
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findById(id);
  }

  @Post()
  @ApiOperation({})
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'body', key: 'editionId' })
  create(@Body() dto: CreateSessionDto) {
    return this.service.create(dto);
  }

  @Post('bulk')
  @ApiOperation({ summary: 'Bulk create sessions' })
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'body', key: '[].editionId' })
  createBulk(
    @Body(new ParseArrayPipe({ items: CreateSessionDto }))
    dtos: CreateSessionDto[],
  ) {
    return this.service.createBulk(dtos);
  }

  @Patch(':id')
  @ApiOperation({})
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'session' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSessionDto,
  ) {
    return this.service.update(id, dto);
  }

  @Patch(':id/status')
  @ApiOperation({})
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'session' })
  @Audit({
    type: 'session_status_changed',
    description: 'Session status changed',
  })
  setStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSessionStatusDto,
  ) {
    return this.service.setStatus(id, dto.status);
  }

  /**
   * Declared before the :id routes for the same reason as `bulk`: a literal
   * path segment must not be swallowed by the UUID param.
   */
  @Post('bulk-delete')
  @HttpCode(204)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'body', key: 'ids', via: 'sessions' })
  @Audit({ type: 'session_deleted', description: 'Sessions deleted in bulk' })
  @ApiOperation({
    summary:
      'Delete several sessions at once, each with its bookmarks, attendance, comments and transcript',
  })
  @ApiResponse({ status: 204, description: 'All deleted' })
  @ApiResponse({
    status: 409,
    description:
      'Some sessions have activity and were kept; the message names them. Retry with force: true',
  })
  async removeMany(@Body() dto: BulkDeleteSessionsDto) {
    await this.service.removeMany(dto.ids, dto.force ?? false);
  }

  @Delete(':id')
  @HttpCode(204)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'session' })
  @Audit({ type: 'session_deleted', description: 'Session deleted' })
  @ApiOperation({
    summary:
      'Delete a session with its bookmarks, attendance, comments and transcript',
  })
  @ApiQuery({
    name: 'force',
    required: false,
    description:
      'Required to delete a session that has attendance, comments or captions',
  })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({
    status: 409,
    description: 'Session has activity; retry with force=true',
  })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('force') force?: string,
  ) {
    await this.service.remove(id, force === 'true');
  }

  @Post(':id/bookmark')
  @HttpCode(204)
  @ApiOperation({})
  async bookmark(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.service.bookmark(user.id, id);
  }

  @Delete(':id/bookmark')
  @HttpCode(204)
  @ApiOperation({})
  async unbookmark(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.service.unbookmark(user.id, id);
  }
}
