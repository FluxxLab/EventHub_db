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
  HideReviewDto,
  ListReviewsDto,
  SubmitReviewDto,
} from './dto/reviews.dto';
import { ReviewsService } from './reviews.service';
import { EditionScoped } from '../common/edition-scope/edition-scope.decorator';

/** Reviews of an edition, written by the delegates who were there. */
@ApiTags('reviews')
@ApiBearerAuth()
@Controller()
export class ReviewsController {
  constructor(private readonly service: ReviewsService) {}

  @Get('editions/:id/reviews')
  @ApiOperation({
    summary:
      "An edition's reviews, newest first, with the caller's own and whether they may write one",
  })
  @ApiResponse({ status: 404, description: 'No such edition, or a draft' })
  list(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListReviewsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.list(id, user.id, query);
  }

  @Post('editions/:id/reviews')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Review an edition; reviewing again replaces the earlier review',
  })
  @ApiResponse({
    status: 403,
    description: 'The event has not started, or the caller did not attend',
  })
  submit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SubmitReviewDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.submit(id, user.id, dto);
  }

  @Delete('editions/:id/reviews/me')
  @HttpCode(204)
  @ApiOperation({ summary: "Delete the caller's review of an edition" })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    await this.service.remove(id, user.id);
  }

  @Patch('reviews/:id/hide')
  @HttpCode(204)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'review' })
  @ApiOperation({ summary: 'Hide or restore a review (moderation)' })
  @ApiResponse({ status: 404, description: 'No such review' })
  async hide(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: HideReviewDto,
  ): Promise<void> {
    await this.service.setHidden(id, dto.hidden);
  }
}
