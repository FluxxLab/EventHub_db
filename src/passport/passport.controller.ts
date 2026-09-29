import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
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
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthUser } from '../auth/strategies/jwt.stategies';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AccessTier } from '../delegate/entities/delegate.entity';
import { CreateBoothDto, StampDto, UpdateBoothDto } from './dto/passport.dto';
import { PassportService } from './passport.service';
import { EditionScoped } from '../common/edition-scope/edition-scope.decorator';

/**
 * Exhibition passport (post-summit report): delegates collect a stamp per
 * stand by scanning its code; a full passport enters the prize draw.
 * Unrelated to the delegate QR pass in `src/pass/`.
 */
@ApiTags('passport')
@ApiBearerAuth()
@Controller()
export class PassportController {
  constructor(private readonly service: PassportService) {}

  @Get('passport')
  @ApiOperation({
    summary: "The caller's passport: every active stand and which are stamped",
  })
  passport(
    @CurrentUser() user: AuthUser,
    @Query('editionId') editionId?: string,
  ) {
    return this.service.view(user.id, editionId || undefined);
  }

  @Post('passport/stamp')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Stamp a stand by its code; repeats are reported, not refused',
  })
  @ApiResponse({ status: 404, description: 'Unknown or inactive code' })
  stamp(@Body() dto: StampDto, @CurrentUser() user: AuthUser) {
    return this.service.stamp(user.id, dto.code);
  }

  @Get('editions/:editionId/booths')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'editionId' })
  @ApiOperation({ summary: 'Every stand of an edition with its stamp count' })
  booths(@Param('editionId', ParseUUIDPipe) editionId: string) {
    return this.service.listBooths(editionId);
  }

  @Post('editions/:editionId/booths')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'editionId' })
  @ApiOperation({ summary: 'Add a stand; the code is generated and returned' })
  createBooth(
    @Param('editionId', ParseUUIDPipe) editionId: string,
    @Body() dto: CreateBoothDto,
  ) {
    return this.service.createBooth(editionId, dto);
  }

  @Get('editions/:editionId/passport/draw')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'editionId' })
  @ApiOperation({
    summary: 'Random delegates with a full passport, for the prize draw',
  })
  draw(
    @Param('editionId', ParseUUIDPipe) editionId: string,
    @Query('count', new DefaultValuePipe(1), ParseIntPipe) count: number,
  ) {
    return this.service.draw(editionId, count);
  }

  @Patch('booths/:id')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'booth' })
  @ApiOperation({ summary: 'Edit a stand, including switching it off' })
  updateBooth(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBoothDto,
  ) {
    return this.service.updateBooth(id, dto);
  }

  @Delete('booths/:id')
  @HttpCode(204)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'booth' })
  @ApiOperation({ summary: 'Delete a stand and every stamp collected at it' })
  async removeBooth(@Param('id', ParseUUIDPipe) id: string) {
    await this.service.removeBooth(id);
  }
}
