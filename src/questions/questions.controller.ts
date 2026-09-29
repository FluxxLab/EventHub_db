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
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthUser } from '../auth/strategies/jwt.stategies';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AccessTier } from '../delegate/entities/delegate.entity';
import {
  CreateQuestionDto,
  ListQuestionsQueryDto,
  UpdateQuestionStatusDto,
} from './dto/questions.dto';
import { QuestionsService } from './questions.service';
import { ThrottleVote } from '../common/throttle/throttle.decorators';
import { EditionScoped } from '../common/edition-scope/edition-scope.decorator';

/**
 * Questions from the floor: delegates ask and upvote during a session, the
 * moderator marks them answered or dismissed (post-summit report, XV.1).
 */
@ApiTags('questions')
@ApiBearerAuth()
@Controller()
export class QuestionsController {
  constructor(private readonly service: QuestionsService) {}

  @Post('sessions/:sessionId/questions')
  @ApiOperation({ summary: 'Ask a question in a session' })
  @ApiResponse({
    status: 400,
    description: 'The caller already has five open questions here',
  })
  create(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() dto: CreateQuestionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.create(sessionId, user, dto);
  }

  @Get('sessions/:sessionId/questions')
  @ApiOperation({
    summary:
      'Ranked questions for a session: open by upvotes, then answered. ?all=true adds dismissed (staff only)',
  })
  list(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Query() query: ListQuestionsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.list(sessionId, user, query.all ?? false);
  }

  @Post('questions/:id/upvote')
  @ThrottleVote()
  @HttpCode(200)
  @ApiOperation({ summary: "Toggle the caller's upvote on a question" })
  upvote(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.toggleUpvote(id, user);
  }

  @Patch('questions/:id/status')
  @Roles(AccessTier.ADMIN, AccessTier.SESSION_ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'question' })
  @ApiOperation({ summary: 'Mark a question open, answered or dismissed' })
  setStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateQuestionStatusDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.setStatus(id, dto.status, user);
  }

  @Delete('questions/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Withdraw a question (asker) or remove it (admin)' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.remove(id, user);
  }
}
