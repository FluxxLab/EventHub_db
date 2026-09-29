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
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthUser } from '../auth/strategies/jwt.stategies';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { DelegatesService } from '../delegate/delegates.service';
import { AvatarUploadDto } from '../delegate/dto/avatar-upload.dto';
import { AccessTier } from '../delegate/entities/delegate.entity';
import { BrowseEditionsDto } from './dto/browse-editions.dto';
import { CreateEditionDto, UpdateEditionDto } from './dto/create-edition.dto';
import { SetEditionCoverDto } from './dto/edition-cover.dto';
import { SetEditionLogoDto } from './dto/edition-logo.dto';
import {
  CreateEditionRoomDto,
  UpdateEditionRoomDto,
} from './dto/edition-room.dto';
import { ListAttendeesDto } from './dto/list-attendees.dto';
import { EditionRoomsService } from './edition-rooms.service';
import { EditionsService } from './editions.service';
import { EditionScoped } from '../common/edition-scope/edition-scope.decorator';
import type { ScopedRequest } from '../common/edition-scope/edition-scope.guard';

@ApiTags('editions')
@ApiBearerAuth()
@Controller('editions')
export class EditionsController {
  constructor(
    private readonly service: EditionsService,
    private readonly delegates: DelegatesService,
    private readonly roomService: EditionRoomsService,
  ) {}

  /**
   * The one call the app makes. Everything the delegate sees hangs off the
   * answer, including whether there is a summit at all.
   */
  @Get('current')
  @ApiOperation({ summary: 'The summit the app should be showing, or null' })
  @ApiResponse({ status: 200, description: 'null between summits' })
  current() {
    return this.service.current();
  }

  @Get('home')
  @ApiOperation({
    summary: 'The app Home feed: popular and upcoming editions as cards',
  })
  @ApiResponse({
    status: 200,
    description: '{ popular: EditionCardView[], upcoming: EditionCardView[] }',
  })
  home() {
    return this.service.home();
  }

  @Get('categories')
  @ApiOperation({
    summary: 'My Events grid: each category with its upcoming count and cover',
  })
  categories() {
    return this.service.categories();
  }

  @Get('browse')
  @ApiOperation({
    summary: 'Editions as cards, filtered by category, search term and time',
  })
  browse(@Query() dto: BrowseEditionsDto) {
    return this.service.browse(dto);
  }

  @Get(':id/attendees')
  @ApiOperation({
    summary:
      'Who is going: ticket holders and delegates engaging with its sessions',
  })
  @ApiResponse({
    status: 200,
    description: '{ items: DelegateDirectoryDto[], total: number }',
  })
  @ApiResponse({ status: 404, description: 'No such edition, or a draft' })
  async attendees(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListAttendeesDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.service.findVisible(id);
    return this.delegates.listEditionAttendees(id, user.id, query);
  }

  @Get(':id/rooms')
  @ApiOperation({
    summary:
      "The venue's rooms: described rooms plus rooms the programme names, with session counts",
  })
  @ApiResponse({
    status: 200,
    description:
      '[{ id: string | null, name, floor, notes, sessionCount }], busiest first',
  })
  @ApiResponse({ status: 404, description: 'No such edition, or a draft' })
  async rooms(@Param('id', ParseUUIDPipe) id: string) {
    await this.service.findVisible(id);
    return this.roomService.list(id);
  }

  @Post(':id/rooms')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @ApiOperation({ summary: 'Describe a room at the venue' })
  @ApiResponse({ status: 409, description: 'A room with that name exists' })
  async createRoom(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateEditionRoomDto,
  ) {
    await this.service.findById(id);
    return this.roomService.create(id, dto);
  }

  @Patch('rooms/:roomId')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'roomId', via: 'room' })
  @ApiOperation({ summary: "Edit a room's name, floor, notes or order" })
  updateRoom(
    @Param('roomId', ParseUUIDPipe) roomId: string,
    @Body() dto: UpdateEditionRoomDto,
  ) {
    return this.roomService.update(roomId, dto);
  }

  @Delete('rooms/:roomId')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'roomId', via: 'room' })
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove a room description; sessions naming it still list it',
  })
  async removeRoom(@Param('roomId', ParseUUIDPipe) roomId: string) {
    await this.roomService.remove(roomId);
  }

  @Get(':id/card')
  @ApiOperation({ summary: 'One edition as the app renders it' })
  @ApiResponse({ status: 404, description: 'No such edition, or a draft' })
  card(@Param('id') id: string) {
    return this.service.card(id);
  }

  /**
   * Public because a shared event link is opened by people without the app
   * or an account: the web page renders this and its link preview (Open
   * Graph) from it. Posters-level facts only; see EditionPublicView.
   */
  @Public()
  @Get(':id/public')
  @ApiOperation({
    summary: 'No-login summary of an edition, for the shared-link web page',
  })
  @ApiResponse({
    status: 200,
    description:
      '{ id, name, shortName, category, status, startsAt, endsAt, city, venue, address, description, coverUrl, registrationOpen, ticketsFrom: { amount, currency: "NGN" } | null }',
  })
  @ApiResponse({
    status: 404,
    description: 'No such edition, a draft, or not an id',
  })
  publicSummary(@Param('id') id: string) {
    return this.service.publicSummary(id);
  }

  @Post(':id/cover-upload')
  @Roles(AccessTier.ADMIN)
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Signed URL for cover artwork: PUT the file to uploadUrl (same Content-Type), then PUT /editions/:id/cover with the key',
  })
  @ApiResponse({ status: 200, description: '{ uploadUrl, key }' })
  @ApiResponse({ status: 404, description: 'No such edition' })
  @ApiResponse({ status: 503, description: 'Uploads are not configured' })
  coverUpload(
    @Param('id', ParseUUIDPipe) id: string,
    // the app's renderable image types, validated before signing
    @Body() dto: AvatarUploadDto,
  ) {
    return this.service.presignCover(id, dto.contentType);
  }

  @Put(':id/cover')
  @Roles(AccessTier.ADMIN)
  @ApiOperation({
    summary: 'Set or replace the cover; the previous uploaded cover is deleted',
  })
  @ApiResponse({ status: 200, description: '{ coverImage, coverUrl }' })
  @ApiResponse({ status: 404, description: 'No such edition' })
  setCover(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetEditionCoverDto,
  ) {
    return this.service.setCover(id, dto.coverImage);
  }

  @Delete(':id/cover')
  @Roles(AccessTier.ADMIN)
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove the cover; the app falls back to its shared artwork',
  })
  @ApiResponse({ status: 404, description: 'No such edition' })
  async removeCover(@Param('id', ParseUUIDPipe) id: string) {
    await this.service.removeCover(id);
  }

  @Delete(':id')
  @Roles(AccessTier.ADMIN)
  @HttpCode(204)
  @ApiOperation({
    summary:
      'Delete an event that has nothing in it yet (no sessions, tickets, orders, polls…)',
  })
  @ApiResponse({ status: 404, description: 'No such edition' })
  @ApiResponse({
    status: 409,
    description:
      'The event the app shows, or it still holds records; the message names them',
  })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.service.remove(id);
  }

  @Post(':id/logo-upload')
  @Roles(AccessTier.ADMIN)
  @HttpCode(200)
  @ApiOperation({
    summary:
      "Signed URL for the event's logo: PUT the file to uploadUrl (same Content-Type), then PUT /editions/:id/logo with the key",
  })
  @ApiResponse({ status: 200, description: '{ uploadUrl, key }' })
  @ApiResponse({ status: 404, description: 'No such edition' })
  @ApiResponse({ status: 503, description: 'Uploads are not configured' })
  logoUpload(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AvatarUploadDto,
  ) {
    return this.service.presignLogo(id, dto.contentType);
  }

  @Put(':id/logo')
  @Roles(AccessTier.ADMIN)
  @ApiOperation({
    summary: 'Set or replace the logo; the previous uploaded logo is deleted',
  })
  @ApiResponse({ status: 200, description: '{ logoImage, logoUrl }' })
  @ApiResponse({ status: 404, description: 'No such edition' })
  setLogo(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetEditionLogoDto,
  ) {
    return this.service.setLogo(id, dto.logoImage);
  }

  @Delete(':id/logo')
  @Roles(AccessTier.ADMIN)
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove the logo' })
  @ApiResponse({ status: 404, description: 'No such edition' })
  async removeLogo(@Param('id', ParseUUIDPipe) id: string) {
    await this.service.removeLogo(id);
  }

  @Get()
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'list' })
  @ApiOperation({
    summary:
      'Every edition, newest first (an event organiser: the ones they run)',
  })
  async list(@Req() req: ScopedRequest) {
    const all = await this.service.list();
    const mine = req.editionScope;
    return mine ? all.filter((e) => mine.includes(e.id)) : all;
  }

  @Post()
  @Roles(AccessTier.ADMIN)
  @ApiOperation({ summary: 'Create an edition. Starts as a draft.' })
  create(@Body() dto: CreateEditionDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @ApiOperation({
    summary: 'Edit an edition: dates, venue, status, registration',
  })
  @ApiResponse({ status: 404, description: 'No such edition' })
  update(@Param('id') id: string, @Body() dto: UpdateEditionDto) {
    return this.service.update(id, dto);
  }

  @Post(':id/current')
  @Roles(AccessTier.ADMIN)
  @ApiOperation({ summary: 'Point the app at this edition' })
  @ApiResponse({ status: 404, description: 'No such edition' })
  setCurrent(@Param('id') id: string) {
    return this.service.setCurrent(id);
  }
}
