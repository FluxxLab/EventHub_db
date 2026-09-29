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
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AccessTier } from '../delegate/entities/delegate.entity';
import type { AuthUser } from '../auth/strategies/jwt.stategies';
import { CreateSpeakerDto } from './dto/create-speaker.dto';
import { UpdateSpeakerDto } from './dto/update-speaker.dto';
import { SetSpeakerRevealDto } from './dto/set-speaker-reveal.dto';
import { SessionsService } from './sessions.service';
import { AvatarUploadDto } from '../delegate/dto/avatar-upload.dto';
import { StorageService } from '../common/storage/storage.service';
import { EditionScoped } from '../common/edition-scope/edition-scope.decorator';

@ApiTags('Speakers')
@ApiBearerAuth()
@Controller('speakers')
export class SpeakersController {
  constructor(
    private readonly service: SessionsService,
    private readonly storage: StorageService,
  ) {}

  // Not @Public(): empty for delegates until the line-up is revealed, full for
  // admin, and telling those apart needs the caller.
  @Get()
  @ApiOperation({
    summary: 'List all speakers - empty for delegates before the reveal',
  })
  list(@CurrentUser() user: AuthUser) {
    return this.service.listSpeakers(
      user.role === AccessTier.ADMIN || user.role === AccessTier.EVENT_ADMIN,
    );
  }

  /**
   * The reveal switch. Readable by everyone because the clients need to know
   * which copy to render ("To be announced" vs the real line-up); writable by
   * admin only.
   */
  @Get('reveal')
  @ApiOperation({ summary: 'Whether speaker identities are public yet' })
  async revealState() {
    return { revealed: await this.service.speakersRevealed() };
  }

  @Post('reveal')
  @HttpCode(200)
  @Roles(AccessTier.ADMIN)
  @ApiOperation({
    summary:
      'Reveal or re-hide every speaker identity across the summit. Broadcasts ' +
      'speakers:revealed so open apps update without relaunching.',
  })
  setReveal(@Body() dto: SetSpeakerRevealDto) {
    return this.service.setSpeakersRevealed(dto.revealed);
  }

  @Post()
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'any' })
  @ApiOperation({ summary: 'Create a speaker' })
  create(@Body() dto: CreateSpeakerDto) {
    return this.service.createSpeaker(dto);
  }
  @Post('avatar-upload')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'any' })
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Signed URL for a speaker photo: PUT the file to uploadUrl, then send publicUrl as avatarUrl when creating the speaker',
  })
  avatarUpload(@Body() dto: AvatarUploadDto) {
    return this.storage.presignUpload({
      folder: 'speaker-avatars',
      contentType: dto.contentType,
    });
  }

  @Patch(':id')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'any' })
  @ApiOperation({
    summary:
      "Edit a speaker's name, role, organisation or photo (speakers are shared across events)",
  })
  @ApiResponse({ status: 404, description: 'No such speaker' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSpeakerDto,
  ) {
    return this.service.updateSpeaker(id, dto);
  }

  @Delete(':id')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'any' })
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a speaker who is on no session' })
  @ApiResponse({ status: 404, description: 'No such speaker' })
  @ApiResponse({
    status: 409,
    description: 'Still on sessions; the message names them',
  })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.service.removeSpeaker(id);
  }
}
