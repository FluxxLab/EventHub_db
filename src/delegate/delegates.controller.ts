import {
  Controller,
  Post,
  Get,
  Delete,
  Res,
  Patch,
  Put,
  Param,
  ParseUUIDPipe,
  Body,
  Query,
  HttpCode,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiBearerAuth,
  ApiResponse,
  ApiParam,
} from '@nestjs/swagger';
import { DelegatesService } from './delegates.service';
import { Audit } from '../common/decorators/audit.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AccessTier } from './entities/delegate.entity';
import {
  CreateRegistrationEntryDto,
  UpdateRegistrationEntryDto,
} from './dto/create-delegate.dto';
import { SetTierDto } from './dto/set-tier.dto';
import { SetApprovalDto } from './dto/set-approval.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../auth/strategies/jwt.stategies';
import { UpdateMeDto } from './dto/update-me.dto';
import type { Response } from 'express';
import { EventSeverity } from '../security/entities/security-event.entity';
import { ListDelegatesDto } from './dto/list-delegates.dto';
import { SetAdminDto } from './entities/set-admin.dto';
import { CreateStaffDto } from './dto/create-staff.dto';
import {
  DelegateDirectoryDto,
  PresenceDto,
} from './dto/delegate-directory.dto';
import { PresenceQueryDto } from './dto/presence-query.dto';
import { ListDirectoryDto } from './dto/list-directory.dto';
import { SendDirectMessageDto } from './dto/send-direct-message.dto';
import { ReactMessageDto } from './dto/react-message.dto';
import { AvatarUploadDto } from './dto/avatar-upload.dto';
import { VoiceNoteUploadDto } from './dto/voice-note.dto';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { ReportDelegateDto } from './dto/report-delegate.dto';
import { SecurityService } from '../security/security.service';
import {
  ThrottleLookup,
  ThrottleMessages,
} from '../common/throttle/throttle.decorators';
import { EditionScoped } from '../common/edition-scope/edition-scope.decorator';

@ApiTags('delegates')
@ApiBearerAuth()
@Controller('delegates')
export class DelegatesController {
  constructor(
    private readonly service: DelegatesService,
    private readonly security: SecurityService,
  ) {}

  @Get()
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'query', key: 'editionId' })
  @ApiOperation({ summary: 'Delegate directory with filters' })
  list(@Query() query: ListDelegatesDto) {
    return this.service.listDelegates(query);
  }

  @Public()
  @Get('directory')
  @ThrottleLookup()
  @ApiOperation({
    summary:
      'Public delegate directory — safe fields only, excludes pending/flagged',
  })
  @ApiResponse({
    status: 200,
    description:
      'Paginated list of delegates visible to all logged-in users (no PII)',
    type: DelegateDirectoryDto,
    isArray: true,
  })
  directory(@Query() query: ListDirectoryDto) {
    return this.service.listDelegatesPublic(query);
  }

  @Post('registration-list')
  @Roles(AccessTier.ADMIN)
  @ApiOperation({ summary: 'Create a new delegate' })
  @ApiResponse({ status: 201, description: 'Delegate created successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @Audit({
    type: 'registration_entry_added',
    description: 'Registration list entry',
  })
  create(@Body() dto: CreateRegistrationEntryDto) {
    return this.service.addRegistrationEntry(dto);
  }

  @Get('registration-list')
  @Roles(AccessTier.ADMIN)
  @ApiOperation({ summary: 'Get all delegates' })
  @ApiResponse({ status: 200, description: 'Delegates retrieved successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @Audit({
    type: 'registration_entry_added',
    description: 'Registration list entry',
  })
  listEntries() {
    return this.service.listRegistrationEntries();
  }

  @Patch('registration-list/:id')
  @Roles(AccessTier.ADMIN)
  @ApiOperation({ summary: 'Update a registration list entry' })
  @ApiResponse({ status: 200, description: 'Entry updated successfully' })
  @Audit({
    type: 'registration_entry_updated',
    description: 'Registration list entry updated',
  })
  updateEntry(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateRegistrationEntryDto,
  ) {
    return this.service.updateRegistrationEntry(id, dto);
  }

  @Delete('registration-list/:id')
  @Roles(AccessTier.ADMIN)
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a registration list entry' })
  @ApiResponse({ status: 204, description: 'Entry deleted successfully' })
  @Audit({
    type: 'registration_entry_deleted',
    description: 'Registration list entry deleted',
  })
  deleteEntry(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.deleteRegistrationEntry(id);
  }

  @Patch(':id/tier')
  @Roles(AccessTier.ADMIN)
  @ApiOperation({ summary: 'Update delegate tier' })
  @ApiResponse({
    status: 200,
    description: 'Delegate tier updated successfully',
  })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @Audit({
    type: 'tier_changed',
    description: 'Delegate access tier changed by admin',
    severity: EventSeverity.WARNING,
  })
  updateTier(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SetTierDto,
  ) {
    return this.service.setTier(id, dto.tier);
  }

  // Single segment, so it cannot be captured by the ':id/...' routes above.
  @Post('approve-all')
  @Roles(AccessTier.ADMIN)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Approve every delegate still awaiting review',
  })
  @ApiResponse({ status: 200, description: 'Returns how many were approved' })
  @Audit({
    type: 'delegates_approved_all',
    description: 'All pending delegates approved by admin',
    severity: EventSeverity.WARNING,
  })
  approveAll() {
    return this.service.approveAll();
  }

  @Patch(':id/approval')
  @Roles(AccessTier.ADMIN)
  @ApiOperation({
    summary: 'Grant or withdraw full access for one delegate',
  })
  @ApiResponse({ status: 200, description: 'Delegate approval updated' })
  @ApiResponse({ status: 404, description: 'Delegate not found' })
  @Audit({
    type: 'delegate_approval_changed',
    description: 'Delegate approval changed by admin',
    severity: EventSeverity.WARNING,
  })
  setApproval(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SetApprovalDto,
  ) {
    return this.service.setApproval(id, dto.approved);
  }

  @Get('export')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'query', key: 'editionId' })
  @ApiOperation({ summary: 'Export delegates as CSV' })
  @ApiResponse({ status: 200, description: 'Delegates exported successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @Audit({
    type: 'delegates_exported',
    description: 'Full delegate PII export downloaded',
    severity: EventSeverity.WARNING,
  })
  async exportCsv(
    @Res() res: Response,
    @Query('editionId', new ParseUUIDPipe({ optional: true }))
    editionId?: string,
  ) {
    // awaited: sending the pending promise downloaded "{}"
    const csv = await this.service.exportCsv(editionId);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send(csv);
  }

  @Get('me')
  @ApiOperation({ summary: 'Get current user delegate' })
  @ApiResponse({
    status: 200,
    description: 'Current user delegate retrieved successfully',
  })
  @ApiResponse({ status: 400, description: 'Bad request' })
  me(@CurrentUser() user: AuthUser) {
    return this.service.profileView(user.id);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update current user delegate' })
  @ApiResponse({
    status: 200,
    description: 'Current user delegate updated successfully',
  })
  @ApiResponse({ status: 400, description: 'Bad request' })
  updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateMeDto) {
    return this.service.updateProfile(user.id, dto);
  }

  @Post('me/avatar-upload')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Signed URL for a profile photo: PUT the file to uploadUrl, then PATCH /delegates/me with the publicUrl',
  })
  @ApiResponse({ status: 200, description: 'uploadUrl, key and publicUrl' })
  @ApiResponse({
    status: 503,
    description: 'Uploads are not configured (no S3_BUCKET)',
  })
  avatarUpload(@Body() dto: AvatarUploadDto) {
    return this.service.presignAvatar(dto.contentType);
  }

  @Post('me/voice-note-upload')
  @ThrottleMessages()
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Signed URL for a DM voice note: PUT the recording to uploadUrl (exactly `size` bytes, the declared Content-Type), then send the key with POST /delegates/:id/messages as audio.key',
  })
  @ApiResponse({ status: 200, description: '{ uploadUrl, key }' })
  @ApiResponse({
    status: 503,
    description: 'Uploads are not configured (no S3_BUCKET)',
  })
  voiceNoteUpload(
    @Body() dto: VoiceNoteUploadDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.presignVoiceNote(user.id, dto);
  }

  @Delete('me/avatar')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove your profile photo; the profile shows initials again',
  })
  @ApiResponse({ status: 204, description: 'Photo removed (or none was set)' })
  async removeAvatar(@CurrentUser() user: AuthUser) {
    await this.service.removeAvatar(user.id);
  }

  @Put('me/tours/:tourId')
  @HttpCode(204)
  @ApiOperation({
    summary:
      'Mark an in-app tour as finished or skipped, so it does not auto-start again',
  })
  @ApiParam({ name: 'tourId', example: 'home' })
  @ApiResponse({ status: 204, description: 'Recorded (or already recorded)' })
  @ApiResponse({ status: 400, description: 'Not a valid tour id' })
  async markTourSeen(
    @CurrentUser() user: AuthUser,
    @Param('tourId') tourId: string,
  ) {
    await this.service.markTourSeen(user.id, tourId);
  }

  @Delete('me')
  @HttpCode(204)
  @ApiOperation({
    summary:
      'Delete your account and all data identifying you. Irreversible; confirmed with your password.',
  })
  @ApiResponse({
    status: 204,
    description: 'Account and personal data removed',
  })
  @ApiResponse({ status: 401, description: 'Password is incorrect' })
  @Audit({
    type: 'delegate_deleted_account',
    description: 'Delegate deleted their own account',
    severity: EventSeverity.WARNING,
  })
  async deleteMe(@CurrentUser() user: AuthUser, @Body() dto: DeleteAccountDto) {
    await this.service.deleteAccount(user.id, dto.password);
  }

  @Get('admins')
  @Roles(AccessTier.ADMIN)
  @ApiOperation({ summary: 'List accounts with admin access' })
  listAdmins() {
    return this.service.listAdmins();
  }

  // Single segment, declared before ':id/...' like approve-all.
  @Post('staff')
  @Roles(AccessTier.ADMIN)
  @ApiOperation({
    summary:
      'Create a staff login (admin or session admin) directly, with no registration or code',
  })
  @ApiResponse({ status: 201, description: 'Staff account created' })
  @ApiResponse({
    status: 409,
    description: 'An account with this email already exists',
  })
  @Audit({
    type: 'staff_account_created',
    description: 'Staff account created by admin',
    severity: EventSeverity.WARNING,
  })
  createStaff(@Body() dto: CreateStaffDto) {
    return this.service.createStaff(dto);
  }

  @Patch(':id/admin')
  @Roles(AccessTier.ADMIN)
  @ApiOperation({ summary: 'Grant or revoke admin access' })
  @Audit({
    type: 'admin_access_changed',
    description: 'Admin access granted or revoked',
    severity: EventSeverity.CRITICAL,
  })
  setAdmin(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SetAdminDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.setAdmin(
      id,
      dto.admin,
      user.id,
      dto.role,
      dto.editionIds,
    );
  }

  @Post(':id/connect')
  @ApiOperation({
    summary:
      'Add delegate to your network (pink ➕ person button). If mutual, marks connection as mutual.',
  })
  @ApiResponse({
    status: 201,
    description: 'Connection created or promoted to mutual',
  })
  connect(
    @Param('id', new ParseUUIDPipe()) toDelegateId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.addConnection(user.id, toDelegateId);
  }

  @Delete(':id/connect')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove a delegate from your network (both directions)',
  })
  @ApiParam({ name: 'id', description: 'Delegate ID', type: String })
  @ApiResponse({ status: 204, description: 'Connection removed' })
  @ApiResponse({ status: 404, description: 'Delegate is not in your network' })
  async disconnect(
    @Param('id', new ParseUUIDPipe()) otherId: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.service.removeConnection(user.id, otherId);
  }

  @Get('me/connections')
  @ApiOperation({
    summary: 'List delegates in your network (the "N in your network" counter)',
  })
  async myConnections(@CurrentUser() user: AuthUser) {
    const [connections, count] = await Promise.all([
      this.service.listConnections(user.id),
      this.service.countConnections(user.id),
    ]);
    return { count, connections };
  }

  // Declared above the ':id' catch-all, like every other static path.
  @Get('me/conversations')
  @ApiOperation({
    summary:
      'Your DM threads (message inbox): other delegate, last message, unread count',
  })
  myConversations(@CurrentUser() user: AuthUser) {
    return this.service.listConversations(user.id);
  }

  // Static path, above the ':id' catch-all.
  @Get('presence')
  @ThrottleLookup()
  @ApiOperation({
    summary:
      'Online status for up to 100 delegates. Anyone hidden from the directory, or with a block either way, reads as offline. Live changes come over the socket (presence:watch / presence:update).',
  })
  @ApiResponse({ status: 200, type: PresenceDto, isArray: true })
  presence(@Query() query: PresenceQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.presenceFor(user.id, query.ids);
  }

  @Post(':id/messages')
  @ThrottleMessages()
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Send a direct message (chat bubble 💬 button); text, a voice note (audio), or both',
  })
  @ApiResponse({
    status: 200,
    description:
      'Message delivered and persisted; voice notes come back with a signed audioUrl and durationMs',
  })
  @ApiResponse({
    status: 400,
    description:
      'Empty message, or a voice note that is not the sender’s own fresh upload',
  })
  sendDm(
    @Param('id', new ParseUUIDPipe()) recipientId: string,
    @Body() dto: SendDirectMessageDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.sendDirectMessage(user.id, recipientId, dto);
  }

  @Get(':id/messages')
  @ApiOperation({
    summary:
      'Get message thread with this delegate (opens the chat bubble conversation, marks messages as read)',
  })
  @ApiQuery({
    name: 'before',
    required: false,
    description:
      'ISO time: the page of messages sent before it (older history). Without it, the newest 100.',
  })
  threadWith(
    @Param('id', new ParseUUIDPipe()) otherDelegateId: string,
    @CurrentUser() user: AuthUser,
    @Query('before') before?: string,
  ) {
    return this.service.listThread(user.id, otherDelegateId, 100, before);
  }

  @Post(':id/block')
  @HttpCode(204)
  @ApiOperation({
    summary:
      'Block a delegate: no DMs or connections in either direction (App Store UGC requirement)',
  })
  @ApiParam({ name: 'id', description: 'Delegate ID', type: String })
  async block(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.service.blockDelegate(user.id, id);
  }

  @Delete(':id/block')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove your block on a delegate' })
  @ApiParam({ name: 'id', description: 'Delegate ID', type: String })
  async unblock(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.service.unblockDelegate(user.id, id);
  }

  /**
   * Report another delegate. Recorded on the security log for organisers to
   * act on (the App Store requires a way to report user-generated content);
   * the reported delegate is not told. Blocking is a separate call.
   */
  @Post(':id/report')
  @HttpCode(204)
  @ApiOperation({ summary: 'Report a delegate to the organisers' })
  @ApiParam({ name: 'id', description: 'Delegate ID', type: String })
  async report(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReportDelegateDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.service.assertReportable(user.id, id);
    await this.security.record({
      type: 'delegate_reported',
      description: `Delegate reported for ${dto.reason}`,
      actorId: user.id,
      severity: EventSeverity.WARNING,
      metadata: {
        reportedId: id,
        reason: dto.reason,
        ...(dto.details?.trim() ? { details: dto.details.trim() } : {}),
      },
    });
  }

  @Get(':id/editions')
  @ApiOperation({
    summary:
      "Events a delegate is part of (ticket, bookmark or attendance), for their profile's Attending section",
  })
  @ApiParam({ name: 'id', description: 'Delegate ID', type: String })
  editions(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.delegateEditions(id, user.id);
  }

  @Get('me/blocks')
  @ApiOperation({
    summary: 'Delegates you have blocked, for client-side state',
  })
  myBlocks(@CurrentUser() user: AuthUser) {
    return this.service.myBlocks(user.id);
  }

  @Post('messages/:messageId/react')
  @HttpCode(200)
  @ApiOperation({
    summary: 'React to a direct message, or clear your reaction with null',
  })
  @ApiParam({ name: 'messageId', description: 'Message ID', type: String })
  @ApiResponse({ status: 200, description: 'The message id and its reactions' })
  @ApiResponse({ status: 404, description: 'Message not in your threads' })
  reactToMessage(
    @Param('messageId', new ParseUUIDPipe()) messageId: string,
    @Body() dto: ReactMessageDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.reactToMessage(user.id, messageId, dto.emoji);
  }

  // Declared last so every static path above ('directory', 'me', 'export',
  // 'admins', 'registration-list') is matched before this catch-all segment.
  @Get(':id')
  @ApiOperation({
    summary:
      'Single delegate — safe fields only. Includes delegates pending review (scanned QR passes resolve here); excludes flagged.',
  })
  @ApiResponse({ status: 200, type: DelegateDirectoryDto })
  @ApiResponse({ status: 404, description: 'Delegate not found or flagged' })
  findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.findDirectoryEntry(id, user.id);
  }
}
