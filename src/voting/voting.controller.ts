import { EditionAccessService } from '../common/edition-scope/edition-access.service';
import {
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  Param,
  ParseUUIDPipe,
  HttpCode,
  Body,
  ForbiddenException,
  Query,
} from '@nestjs/common';
import { Audit } from '../common/decorators/audit.decorator';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { VotingService } from './voting.service';
import { CreatePitchEntryDto } from './dto/create-pitch-entry.dto';
import { UpdatePitchEntryDto } from './dto/update-pitch-entry.dto';
import { CreatePitchTopicDto } from './dto/create-pitch-topic.dto';
import { UpdatePitchTopicDto } from './dto/update-pitch-topic.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { AccessTier } from '../delegate/entities/delegate.entity';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../auth/strategies/jwt.stategies';
import { ThrottleVote } from '../common/throttle/throttle.decorators';
import { EditionScoped } from '../common/edition-scope/edition-scope.decorator';

@ApiTags('Voting')
@ApiBearerAuth()
@Controller('voting')
export class VotingController {
  constructor(
    private readonly votingService: VotingService,
    private readonly access: EditionAccessService,
  ) {}

  /**
   * Whether the caller sees unopened ballots: organisers always, an event
   * organiser for an event they run. Everyone else sees the reveal as it happens.
   */
  private async curator(user: AuthUser, editionId?: string): Promise<boolean> {
    if (user.role === AccessTier.ADMIN) return true;
    if (user.role !== AccessTier.EVENT_ADMIN || !editionId) return false;
    return (await this.access.editionsOf(user.id)).includes(editionId);
  }

  /* ---------------------------------------------------------------- topics */

  // Not @Public(): what comes back depends on who is asking. A pending topic
  // and its pitches are withheld until voting opens, and only admin - who
  // curates them - sees them before that.
  @Get('topics')
  @ApiOperation({
    summary:
      'Topics with their pitches, live standing and voting state. Pending ' +
      'topics are withheld from everyone but admin until voting opens.',
  })
  async listTopics(
    @CurrentUser() user: AuthUser,
    @Query('editionId', new ParseUUIDPipe({ optional: true }))
    editionId?: string,
  ) {
    return this.votingService.listTopics(
      await this.curator(user, editionId),
      editionId,
    );
  }

  @Post('topics')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'body', key: 'editionId' })
  @ApiOperation({ summary: 'Create a pitchathon topic' })
  @Audit({ type: 'pitch_topic_created', description: 'Pitch topic created' })
  createTopic(@Body() dto: CreatePitchTopicDto) {
    return this.votingService.createTopic(dto);
  }

  @Patch('topics/:id')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'pitchTopic' })
  @ApiOperation({ summary: 'Rename or reorder a topic' })
  updateTopic(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePitchTopicDto,
  ) {
    return this.votingService.updateTopic(id, dto);
  }

  @Post('topics/:id/open')
  @HttpCode(200)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'pitchTopic' })
  @ApiOperation({ summary: 'Open the ballot for a topic' })
  @Audit({ type: 'pitch_voting_opened', description: 'Pitch voting opened' })
  openVoting(@Param('id', ParseUUIDPipe) id: string) {
    return this.votingService.openVoting(id);
  }

  @Post('topics/:id/close')
  @HttpCode(200)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'pitchTopic' })
  @ApiOperation({
    summary: 'Close the ballot and freeze the result that gets announced',
  })
  @Audit({ type: 'pitch_voting_closed', description: 'Pitch voting closed' })
  closeVoting(@Param('id', ParseUUIDPipe) id: string) {
    return this.votingService.closeVoting(id);
  }

  @Delete('topics/:id')
  @HttpCode(204)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'pitchTopic' })
  @ApiOperation({ summary: 'Remove a topic, its pitches and its ballots' })
  @Audit({ type: 'pitch_topic_deleted', description: 'Pitch topic deleted' })
  async removeTopic(@Param('id', ParseUUIDPipe) id: string) {
    await this.votingService.removeTopic(id);
  }

  /* --------------------------------------------------------------- entries */

  // Both of these reach the same pitches without the topic wrapper, so they
  // carry the same rule - otherwise the withheld line-up is one request away.
  @Get('entries')
  @ApiOperation({
    summary: 'Pitch entries, excluding those on a topic that has not opened',
  })
  async listEntries(
    @CurrentUser() user: AuthUser,
    @Query('editionId', new ParseUUIDPipe({ optional: true }))
    editionId?: string,
  ) {
    return this.votingService.listEntries(
      await this.curator(user, editionId),
      editionId,
    );
  }

  @Get('top-pitches')
  @ApiOperation({
    summary: 'Most-voted pitches across all open topics (Overview widget)',
  })
  async topPitches(
    @CurrentUser() user: AuthUser,
    @Query('editionId', new ParseUUIDPipe({ optional: true }))
    editionId?: string,
  ) {
    return this.votingService.topPitches(
      10,
      await this.curator(user, editionId),
      editionId,
    );
  }

  @Post('entries')
  @ApiOperation({ summary: 'Create a new pitch entry' })
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'body', key: 'topicId', via: 'pitchTopic' })
  createEntry(@Body() dto: CreatePitchEntryDto) {
    return this.votingService.createEntry(dto);
  }

  @Patch('entries/:id')
  @ApiOperation({ summary: 'Edit a pitch entry (ballots are not affected)' })
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'pitchEntry' })
  @Audit({ type: 'pitch_entry_updated', description: 'Pitch entry updated' })
  async updateEntry(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePitchEntryDto,
    @CurrentUser() user: AuthUser,
  ) {
    // moving a pitch: the ballot it lands on must be in one of their events too
    if (dto.topicId && user.role === AccessTier.EVENT_ADMIN) {
      const [target] = await this.access.editionsFor('pitchTopic', dto.topicId);
      if (
        !target ||
        !(await this.access.editionsOf(user.id)).includes(target)
      ) {
        throw new ForbiddenException('This belongs to an event you do not run');
      }
    }
    return this.votingService.updateEntry(id, dto);
  }

  @Delete('entries/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a pitch entry and every ballot cast on it' })
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'pitchEntry' })
  @Audit({ type: 'pitch_entry_deleted', description: 'Pitch entry deleted' })
  async removeEntry(@Param('id', ParseUUIDPipe) id: string) {
    await this.votingService.removeEntry(id);
  }

  /* ----------------------------------------------------------------- votes */

  @Post('entry/:id/vote')
  @ThrottleVote()
  @ApiOperation({
    summary:
      "Cast or change this delegate's vote in the pitch's topic. One ballot " +
      'per delegate per topic; re-casting moves it. Returns the topic tally.',
  })
  @HttpCode(200)
  vote(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.votingService.castVote(user.id, id);
  }

  @Get('my-votes')
  @ApiOperation({
    summary:
      'topicId -> entryId this delegate has voted for; one event only when editionId is given',
  })
  myVotes(
    @CurrentUser() user: AuthUser,
    @Query('editionId', new ParseUUIDPipe({ optional: true }))
    editionId?: string,
  ) {
    return this.votingService.myVotes(user.id, editionId);
  }
}
