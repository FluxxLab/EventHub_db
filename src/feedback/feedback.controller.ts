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
import { FeedbackSummaryQueryDto, SubmitFeedbackDto } from './dto/feedback.dto';
import { FeedbackService } from './feedback.service';
import { EditionScoped } from '../common/edition-scope/edition-scope.decorator';

/**
 * Session feedback: one rating per delegate per session, summarised for the
 * organisers (post-summit report, XV.2).
 */
@ApiTags('feedback')
@ApiBearerAuth()
@Controller()
export class FeedbackController {
  constructor(private readonly service: FeedbackService) {}

  @Post('sessions/:sessionId/feedback')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Rate a session; rating again replaces the earlier rating',
  })
  submit(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() dto: SubmitFeedbackDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.submit(sessionId, user.id, dto);
  }

  @Get('sessions/:sessionId/feedback/me')
  @ApiOperation({ summary: "The caller's rating of a session, or null" })
  mine(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.mine(sessionId, user.id);
  }

  @Get('sessions/:sessionId/feedback')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'sessionId', via: 'session' })
  @ApiOperation({
    summary: 'Count, average, star distribution and comments for a session',
  })
  summary(@Param('sessionId', ParseUUIDPipe) sessionId: string) {
    return this.service.sessionSummary(sessionId);
  }

  @Get('feedback/summary')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'query', key: 'editionId' })
  @ApiOperation({ summary: 'Every session of an edition by average rating' })
  editionSummary(@Query() query: FeedbackSummaryQueryDto) {
    return this.service.editionSummary(query.editionId);
  }
}
