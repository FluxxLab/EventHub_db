import {
  Body,
  Controller,
  Delete,
  Get,
  DefaultValuePipe,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthUser } from '../auth/strategies/jwt.stategies';
import { AccessTier } from '../delegate/entities/delegate.entity';
import { AnswerTriviaDto } from './dto/answer-trivia.dto';
import { CreateTriviaQuestionDto } from './dto/create-trivia.dto';
import { UpdateTriviaQuestionDto } from './dto/update-trivia.dto';
import { TriviaService } from './trivia.service';
import { Audit } from '../common/decorators/audit.decorator';
import { ThrottleVote } from '../common/throttle/throttle.decorators';
import { EditionScoped } from '../common/edition-scope/edition-scope.decorator';

@ApiTags('Trivia')
@ApiBearerAuth()
@Controller('trivia')
export class TriviaController {
  constructor(private readonly service: TriviaService) {}

  @Public()
  @Get('current')
  @ApiOperation({
    summary:
      "The live question without its answer; one event's when editionId is given",
  })
  current(
    @Query('editionId', new ParseUUIDPipe({ optional: true }))
    editionId?: string,
  ) {
    return this.service.currentQuestion(editionId);
  }

  @Get('history')
  @ApiOperation({
    summary:
      "A delegate's own closed questions, with their answer, the reveal and the points",
  })
  @ApiResponse({ status: 200, description: 'Closed questions, newest first' })
  history(
    @CurrentUser() user: AuthUser,
    @Query('editionId', new ParseUUIDPipe({ optional: true }))
    editionId?: string,
  ) {
    return this.service.historyFor(user.id, editionId);
  }

  @Get('leaderboard')
  @ApiOperation({
    summary:
      "An event's trivia board: the top N (default 10, max 50) and the caller's own rank and score",
  })
  leaderboard(
    @CurrentUser() user: AuthUser,
    @Query('editionId', new ParseUUIDPipe({ optional: true }))
    editionId?: string,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit = 10,
  ) {
    return this.service.leaderboard(
      user.id,
      editionId,
      Math.min(50, Math.max(1, limit)),
    );
  }

  @Get(':id/result')
  @ApiOperation({
    summary:
      "The caller's outcome on a closed question: correct, points, running total and rank",
  })
  @ApiResponse({ status: 409, description: 'The question has not closed yet' })
  result(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.resultFor(user.id, id);
  }

  @Post(':id/answer')
  @ThrottleVote()
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Answer the live question once. The reply confirms receipt only; correctness waits for the close',
  })
  answer(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnswerTriviaDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.answer(user.id, id, dto);
  }

  @Get()
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'query', key: 'editionId' })
  @ApiOperation({})
  listAll(
    @Query('editionId', new ParseUUIDPipe({ optional: true }))
    editionId?: string,
  ) {
    return this.service.listAll(editionId);
  }
  @Post()
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'body', key: 'editionId' })
  @ApiOperation({})
  create(@Body() dto: CreateTriviaQuestionDto) {
    return this.service.create(dto);
  }

  @Patch(':id/close')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'trivia' })
  @ApiOperation({
    summary: '',
  })
  close(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.close(id);
  }

  @Patch(':id/live')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'trivia' })
  @Audit({ type: 'trivia_live', description: 'Trivia pushed to live' })
  @ApiOperation({
    summary: '',
  })
  pushLive(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.pushLive(id);
  }

  // Declared after ':id/close' and ':id/live' so those keep matching first.
  @Patch(':id')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'trivia' })
  @Audit({ type: 'trivia_updated', description: 'Trivia question edited' })
  @ApiOperation({
    summary: 'Edit a question (a live one is re-sent to delegates)',
  })
  @ApiResponse({ status: 404, description: 'No such question' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTriviaQuestionDto,
  ) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'trivia' })
  @Audit({ type: 'trivia_deleted', description: 'Trivia question deleted' })
  @ApiOperation({
    summary: 'Delete a question along with every answer given to it',
  })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 404, description: 'No such question' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.service.remove(id);
  }

  @Get(':id/stats')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'trivia' })
  stats(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.stats(id);
  }
}
