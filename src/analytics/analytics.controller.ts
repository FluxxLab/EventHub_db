import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
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
import { AnalyticsService } from './analytics.service';
import { IngestEventsDto, SummaryQueryDto } from './dto/analytics.dto';

/**
 * Product analytics: the app reports what delegates did, the console reads
 * the totals for the post-summit report. Nothing here is shown back to a
 * delegate.
 */
@ApiTags('analytics')
@ApiBearerAuth()
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly service: AnalyticsService) {}

  @Post('events')
  @HttpCode(204)
  @ApiOperation({ summary: 'Record a batch of app events for the caller' })
  @ApiResponse({ status: 204, description: 'Stored' })
  @ApiResponse({ status: 400, description: 'Bad event name, date or props' })
  async ingest(@Body() dto: IngestEventsDto, @CurrentUser() user: AuthUser) {
    await this.service.ingest(user.id, dto);
  }

  @Get('summary')
  @Roles(AccessTier.ADMIN)
  @ApiOperation({
    summary: 'Usage totals for a date range (default: the last 7 days)',
  })
  summary(@Query() query: SummaryQueryDto) {
    return this.service.summary(query.from, query.to);
  }
}
