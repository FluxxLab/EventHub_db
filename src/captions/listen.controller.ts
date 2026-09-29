import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiPropertyOptional,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';
import type { AuthUser } from '../auth/strategies/jwt.stategies';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ThrottleLookup } from '../common/throttle/throttle.decorators';
import { ListenService } from './listen.service';

export class ListenDto {
  @ApiPropertyOptional({
    description:
      'Channel id from a previous grant (floor, or an interpretation channel). Defaults to the first on air.',
    example: 'floor',
  })
  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{1,32}$/, { message: 'channel is not a channel id' })
  channel?: string;
}

/**
 * Listen-only room audio for the app's session page. Lives with the LiveKit
 * pieces rather than in SessionsModule, which this module already imports.
 */
@ApiTags('sessions')
@ApiBearerAuth()
@Controller('sessions')
export class ListenController {
  constructor(private readonly listen: ListenService) {}

  @Post(':id/listen')
  @HttpCode(200)
  @ThrottleLookup()
  @ApiOperation({
    summary:
      'Subscribe-only LiveKit token for a live session’s room audio (10 minutes; ask again before expiresAt)',
  })
  @ApiResponse({
    status: 200,
    description:
      '{ url, token, room, channel, channels: [{ id, label }], expiresAt }',
  })
  @ApiResponse({
    status: 403,
    description: 'No ticket for the session’s event',
  })
  @ApiResponse({
    status: 404,
    description:
      'Session not found or not live, audio off for the event, or channel not on air',
  })
  @ApiResponse({ status: 503, description: 'LiveKit not configured' })
  grant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ListenDto,
    @CurrentUser() user: AuthUser,
  ) {
    // the app may POST with no body at all
    return this.listen.grant(id, user, dto?.channel);
  }
}
