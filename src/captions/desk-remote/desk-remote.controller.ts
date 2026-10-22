import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthUser } from '../../auth/strategies/jwt.stategies';
import { AccessTier } from '../../delegate/entities/delegate.entity';
import { DeskRemoteService } from './desk-remote.service';

export class DeskCommandDto {
  @ApiProperty({ enum: ['patch', 'start', 'stop'] })
  @IsIn(['patch', 'start', 'stop'])
  action: 'patch' | 'start' | 'stop';

  @ApiProperty({ example: 'Main Hall' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  room: string;

  @ApiPropertyOptional({
    description: 'For patch: the channel, or empty to unpatch',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  source?: string;
}

@ApiTags('captions')
@ApiBearerAuth()
@Controller('capture-desks')
export class DeskRemoteController {
  constructor(private readonly desks: DeskRemoteService) {}

  @Get()
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN, AccessTier.SESSION_ADMIN)
  @ApiOperation({
    summary:
      'The sound desks online now: their channels, rooms, patches and what is on air',
  })
  list() {
    return this.desks.list();
  }

  @Post(':deskId/command')
  @HttpCode(200)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN, AccessTier.SESSION_ADMIN)
  @Audit({
    type: 'capture_desk_command',
    description: 'Sound desk run from another computer',
  })
  @ApiOperation({
    summary:
      'Patch, start or stop a room on a sound desk from another computer',
  })
  command(
    @Param('deskId') deskId: string,
    @Body() dto: DeskCommandDto,
    @CurrentUser() user: AuthUser,
  ) {
    if (!/^[a-z0-9-]{1,64}$/i.test(deskId))
      throw new BadRequestException('Unknown desk.');
    return this.desks.command(
      deskId,
      dto.action,
      dto.room,
      dto.source,
      user.id,
    );
  }
}
