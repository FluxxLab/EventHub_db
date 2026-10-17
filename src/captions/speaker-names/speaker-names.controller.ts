import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { AccessTier } from '../../delegate/entities/delegate.entity';
import {
  CreateSpeakerNameDto,
  UpdateSpeakerNameDto,
} from './speaker-names.dto';
import { SpeakerNamesService } from './speaker-names.service';

/**
 * Who the voices and mics in a session's captions are. Open to the tiers
 * that read the transcript: admins and caption operators.
 */
@ApiTags('captions')
@ApiBearerAuth()
@Controller()
export class SpeakerNamesController {
  constructor(private readonly names: SpeakerNamesService) {}

  @Get('sessions/:id/speaker-names')
  @Roles(AccessTier.ADMIN, AccessTier.SESSION_ADMIN)
  @ApiOperation({
    summary: "A session's speaker names (all but the rejected), by start",
  })
  list(@Param('id', ParseUUIDPipe) sessionId: string) {
    return this.names.list(sessionId);
  }

  @Post('sessions/:id/speaker-names')
  @HttpCode(201)
  @Roles(AccessTier.ADMIN, AccessTier.SESSION_ADMIN)
  @ApiOperation({ summary: 'Name a voice or a mic by hand; applied at once' })
  @ApiResponse({ status: 201, description: 'The binding, confirmed' })
  create(
    @Param('id', ParseUUIDPipe) sessionId: string,
    @Body() dto: CreateSpeakerNameDto,
  ) {
    return this.names.create(sessionId, dto);
  }

  @Post('sessions/:id/speaker-names/review')
  @HttpCode(202)
  @Roles(AccessTier.ADMIN, AccessTier.SESSION_ADMIN)
  @ApiOperation({
    summary:
      'Have the AI read the whole session and name its voices and mics; queued',
  })
  @ApiResponse({ status: 202, description: '{ jobId }' })
  @ApiResponse({
    status: 400,
    description: 'Speaker naming is off for the event',
  })
  @ApiResponse({ status: 503, description: 'AI not configured' })
  review(@Param('id', ParseUUIDPipe) sessionId: string) {
    return this.names.queueReview(sessionId);
  }

  @Get('speaker-names/review/:jobId')
  @Roles(AccessTier.ADMIN, AccessTier.SESSION_ADMIN)
  @ApiOperation({ summary: 'How a review is getting on' })
  @ApiResponse({
    status: 200,
    description: '{ state, added?, changed?, error? }',
  })
  reviewStatus(@Param('jobId') jobId: string) {
    if (!/^review-[0-9a-f-]{36}$/.test(jobId)) {
      throw new BadRequestException('Not a review job id');
    }
    return this.names.reviewStatus(jobId);
  }

  @Patch('speaker-names/:id')
  @Roles(AccessTier.ADMIN, AccessTier.SESSION_ADMIN)
  @ApiOperation({ summary: 'Confirm, reject or correct a speaker name' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSpeakerNameDto,
  ) {
    return this.names.update(id, dto);
  }

  @Delete('speaker-names/:id')
  @HttpCode(204)
  @Roles(AccessTier.ADMIN, AccessTier.SESSION_ADMIN)
  @ApiOperation({ summary: 'Remove a speaker name' })
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.names.remove(id);
  }
}
