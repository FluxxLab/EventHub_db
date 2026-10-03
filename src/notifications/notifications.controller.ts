import {
  Body,
  Controller,
  Delete,
  Get,
  Query,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { isUUID } from 'class-validator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthUser } from '../auth/strategies/jwt.stategies';
import { AccessTier } from '../delegate/entities/delegate.entity';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { Notification } from './entities/notification.entity';
import { NotificationsService } from './notifications.service';
import { Audit } from '../common/decorators/audit.decorator';
import { EditionScoped } from '../common/edition-scope/edition-scope.decorator';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Get()
  @ApiOperation({
    summary: "Inbox: sent notifications targeting the caller's segments",
  })
  @ApiResponse({
    status: 200,
    description: 'Returns all notifications',
    type: [Notification],
  })
  async findAll(@CurrentUser() user: AuthUser) {
    return this.service.inboxFor(user);
  }

  @Get('whatsapp-reach')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'query', key: 'editionId' })
  @ApiOperation({
    summary:
      'How many delegates in a segment would get an announcement on WhatsApp, and whether WhatsApp is connected',
  })
  @ApiResponse({ status: 200, description: '{ recipients, live }' })
  whatsappReach(
    @Query('segment') segment = 'all',
    @Query('editionId') editionId?: string,
    /** Comma-separated ticket tier ids of the event; empty is everyone at it. */
    @Query('ticketTypeIds') ticketTypeIds?: string,
  ) {
    const tiers = (ticketTypeIds ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter((t) => isUUID(t));
    return this.service.whatsappReach(segment, editionId || null, tiers);
  }

  @Post()
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'body', key: 'editionId' })
  @Audit({ type: 'notification_created', description: 'Notification created' })
  @ApiOperation({
    summary: 'Announce: create + queue  a push to a segment (admin composer)',
  })
  @ApiResponse({
    status: 201,
    description: 'Persisted and queued; sending happens asynchronously ',
    type: Notification,
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden: only admins can announce',
  })
  async create(@Body() dto: CreateNotificationDto) {
    // the acting admin is captured by the @Audit interceptor, not here
    return this.service.announce(dto);
  }

  // Declared before the 'register' routes only for reading order; the path
  // segment ':id' is constrained to a UUID so it cannot swallow them.
  @Delete(':id')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'notification' })
  @HttpCode(204)
  @Audit({ type: 'notification_deleted', description: 'Notification deleted' })
  @ApiOperation({
    summary: 'Retract an announcement: removes it from every delegate inbox',
  })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 404, description: 'No such notification' })
  async remove(@Param('id', new ParseUUIDPipe()) id: string) {
    await this.service.remove(id);
  }

  @Post(':id/read')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Mark one inbox notification as read for the caller',
  })
  @ApiResponse({ status: 204, description: 'Recorded (idempotent)' })
  async markRead(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.service.markRead(user.id, id);
  }

  @Post('register')
  @ApiOperation({
    summary: "Register this device's FCM token for push delivery",
  })
  @ApiResponse({
    status: 204,
    description: 'Token registered (or reassigned to this delegate',
  })
  async register(
    @Body() dto: RegisterDeviceDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.service.registerDevice(user.id, dto.token, dto.platform);
  }

  @Delete('register')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Stop push to this device (Settings > Push notifications off)',
  })
  @ApiResponse({
    status: 204,
    description: 'Device removed if it was registered',
  })
  async unregister(
    @Body() dto: RegisterDeviceDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.service.unregisterDevice(user.id, dto.token);
  }
}
