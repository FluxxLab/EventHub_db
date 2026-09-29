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
import { CreatePollDto, UpdatePollDto, VotePollDto } from './dto/polls.dto';
import { PollsService } from './polls.service';
import { ThrottleVote } from '../common/throttle/throttle.decorators';
import { EditionScoped } from '../common/edition-scope/edition-scope.decorator';

/**
 * Polls from the stage (post-summit report). Delegates answer the open one
 * and browse closed ones; operators author, open and close them.
 */
@ApiTags('polls')
@ApiBearerAuth()
@Controller('polls')
export class PollsController {
  constructor(private readonly service: PollsService) {}

  // Literal paths are declared before ':id' so they are not read as ids.

  @Get('current')
  @ApiOperation({ summary: 'The open poll, or null when the stage is quiet' })
  current(
    @CurrentUser() user: AuthUser,
    @Query('editionId') editionId?: string,
  ) {
    return this.service.current(user, editionId || undefined);
  }

  @Get('history')
  @ApiOperation({ summary: 'Closed polls with their results, newest first' })
  history(
    @CurrentUser() user: AuthUser,
    @Query('editionId') editionId?: string,
  ) {
    return this.service.history(user, editionId || undefined);
  }

  @Get()
  @Roles(AccessTier.ADMIN, AccessTier.SESSION_ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'query', key: 'editionId' }, { from: 'current' })
  @ApiOperation({ summary: 'Every poll of an edition, whatever its status' })
  list(@CurrentUser() user: AuthUser, @Query('editionId') editionId?: string) {
    return this.service.list(user, editionId || undefined);
  }

  @Post()
  @Roles(AccessTier.ADMIN, AccessTier.SESSION_ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped(
    { from: 'body', key: 'sessionId', via: 'session' },
    { from: 'body', key: 'editionId' },
    { from: 'current' },
  )
  @ApiOperation({ summary: 'Draft a poll' })
  create(@Body() dto: CreatePollDto, @CurrentUser() user: AuthUser) {
    return this.service.create(user, dto);
  }

  @Post(':id/vote')
  @ThrottleVote()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Answer the open poll; a second vote replaces the first',
  })
  @ApiResponse({
    status: 400,
    description: 'Poll not open or option out of range',
  })
  vote(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VotePollDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.vote(user, id, dto.optionIndex);
  }

  @Post(':id/open')
  @HttpCode(200)
  @Roles(AccessTier.ADMIN, AccessTier.SESSION_ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'poll' })
  @ApiOperation({
    summary:
      'Open the poll to the room, closing any other open poll of the edition',
  })
  open(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.open(user, id);
  }

  @Post(':id/close')
  @HttpCode(200)
  @Roles(AccessTier.ADMIN, AccessTier.SESSION_ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'poll' })
  @ApiOperation({ summary: 'Close the poll and reveal its results' })
  close(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.close(user, id);
  }

  @Patch(':id')
  @Roles(AccessTier.ADMIN, AccessTier.SESSION_ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'poll' })
  @ApiOperation({ summary: 'Edit a draft poll' })
  @ApiResponse({ status: 400, description: 'Poll is no longer a draft' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePollDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.update(user, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @Roles(AccessTier.ADMIN, AccessTier.SESSION_ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'poll' })
  @ApiOperation({ summary: 'Delete a poll and every vote on it' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.service.remove(id);
  }
}
