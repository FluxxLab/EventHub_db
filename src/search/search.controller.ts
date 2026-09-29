import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { QuerySearchDto } from './dto/query-search.dto';
import { SearchService } from './search.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AccessTier } from '../delegate/entities/delegate.entity';
import type { AuthUser } from '../auth/strategies/jwt.stategies';
import { ThrottleLookup } from '../common/throttle/throttle.decorators';

@ApiTags('Search')
@Controller('search')
@ApiBearerAuth()
export class SearchController {
  constructor(private readonly service: SearchService) {}

  @Get()
  @ThrottleLookup()
  @ApiOperation({
    summary: 'Global search across sessions, speakers and delegates',
    description:
      'Case-insensitive substring match. Results are grouped by categoies, each capped at 10',
  })
  @ApiResponse({
    status: 200,
    description: 'Group Results: {sessions, speakers, delegates',
  })
  @ApiResponse({ status: 400, description: 'q shorter than 2 characters' })
  search(@Query() dto: QuerySearchDto, @CurrentUser() user: AuthUser) {
    return this.service.search(dto, user.role === AccessTier.ADMIN);
  }
}
