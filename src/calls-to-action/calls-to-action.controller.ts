import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/strategies/jwt.stategies';
import { Audit } from '../common/decorators/audit.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { EditionScoped } from '../common/edition-scope/edition-scope.decorator';
import { AccessTier } from '../delegate/entities/delegate.entity';
import { CallsToActionService } from './calls-to-action.service';
import {
  AddStakeholderLinkDto,
  CreateCallToActionDto,
  DeckScopeDto,
  DeleteCallsToActionDto,
  MergeCallsToActionDto,
  SaveCallToActionDto,
  SetStakeholderLinkDto,
} from './dto/calls-to-action.dto';

/** An event's calls to action: analysed from its sessions, reviewed by its organisers. */
@ApiTags('calls-to-action')
@ApiBearerAuth()
@Controller()
export class CallsToActionController {
  constructor(private readonly calls: CallsToActionService) {}

  @Get('editions/:id/calls-to-action')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @ApiOperation({
    summary:
      "An event's calls to action, how far each session has been analysed, and whether the AI is set up",
  })
  list(@Param('id', ParseUUIDPipe) id: string) {
    return this.calls.list(id);
  }

  @Get('editions/:id/calls-to-action/stakeholders')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @ApiOperation({
    summary:
      "The event's organisations: each one's delegates, the recommendations aimed at it and its commitments",
  })
  stakeholders(@Param('id', ParseUUIDPipe) id: string) {
    return this.calls.stakeholders(id);
  }

  @Post('editions/:id/calls-to-action/stakeholders/suggest')
  @HttpCode(200)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @ApiOperation({
    summary:
      'Asks the AI which of the event’s organisations fall under each broad target ("Federal Government"); kept as suggestions to confirm',
  })
  suggestLinks(@Param('id', ParseUUIDPipe) id: string) {
    return this.calls.suggestLinks(id);
  }

  @Patch('editions/:id/calls-to-action/stakeholder-links/:linkId')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @ApiOperation({ summary: 'Confirms or rejects a stakeholder link' })
  setLink(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('linkId', ParseUUIDPipe) linkId: string,
    @Body() dto: SetStakeholderLinkDto,
  ) {
    return this.calls.setLink(id, linkId, dto.status);
  }

  @Post('editions/:id/calls-to-action/stakeholder-links')
  @HttpCode(200)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @ApiOperation({
    summary:
      'Ties a broad target to one of the event’s organisations, confirmed',
  })
  addLink(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddStakeholderLinkDto,
  ) {
    return this.calls.addLink(id, dto.target, dto.organisation);
  }

  @Get('editions/:id/calls-to-action/targets')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @ApiOperation({
    summary:
      'Who a call to action may be directed at: the usual groups and the event’s organisations',
  })
  targets(@Param('id', ParseUUIDPipe) id: string) {
    return this.calls.targets(id);
  }

  @Post('sessions/:id/analyse')
  @HttpCode(200)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'session' })
  @Audit({
    type: 'session_analysed',
    description: 'Session transcript analysed for calls to action',
  })
  @ApiOperation({
    summary:
      'Read what the session has said since its last analysis and suggest its calls to action',
  })
  @ApiQuery({
    name: 'fromStart',
    required: false,
    description: 'true reads the whole session again, not only what is new',
  })
  analyse(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('fromStart') fromStart?: string,
  ) {
    return this.calls.analyse(id, fromStart === 'true');
  }

  @Post('sessions/:id/rapporteur-report')
  @HttpCode(200)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'session' })
  @Audit({
    type: 'session_report_written',
    description: 'Rapporteur report written from a session transcript',
  })
  @ApiOperation({
    summary:
      "The session's rapporteur report (insights, perspectives, opportunities, challenges, recommendations, commitments, synthesis), written by AI from its transcript",
  })
  writeReport(@Param('id', ParseUUIDPipe) id: string) {
    return this.calls.writeReport(id);
  }

  @Get('editions/:id/calls-to-action/deck-images')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @ApiOperation({
    summary:
      "The event's logo and dark-background logo as images, for the template decks",
  })
  deckImages(@Param('id', ParseUUIDPipe) id: string) {
    return this.calls.deckImages(id);
  }

  @Post('editions/:id/calls-to-action/deck-design')
  @HttpCode(200)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @ApiOperation({
    summary:
      "A fresh AI design for a call-to-action deck: one session's slide or one day's deck, with the event's logo and cover",
  })
  designDeck(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() scope: DeckScopeDto,
  ) {
    return this.calls.designDeck(id, scope);
  }

  @Post('editions/:id/calls-to-action')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @ApiOperation({ summary: 'Add a call to action by hand (approved)' })
  create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCallToActionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.calls.create(id, user.id, dto);
  }

  @Patch('calls-to-action/:id')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'callToAction' })
  @ApiOperation({
    summary:
      'Edit a call to action, or approve, reject or return it to suggested',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveCallToActionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.calls.update(id, user.id, dto);
  }

  @Post('editions/:id/calls-to-action/delete')
  @HttpCode(200)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @Audit({
    type: 'calls_to_action_deleted',
    description: 'Calls to action deleted',
  })
  @ApiOperation({
    summary:
      'Delete calls to action of this event (and any merged into them), e.g. before analysing a session again',
  })
  removeMany(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeleteCallsToActionDto,
  ) {
    return this.calls.removeMany(id, dto.ids);
  }

  @Post('calls-to-action/merge')
  @HttpCode(200)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'body', key: 'into', via: 'callToAction' })
  @ApiOperation({
    summary:
      'Fold duplicates into one; their speakers join it and they stay on record as merged',
  })
  merge(@Body() dto: MergeCallsToActionDto, @CurrentUser() user: AuthUser) {
    return this.calls.merge(dto.into, dto.ids, user.id);
  }
}
