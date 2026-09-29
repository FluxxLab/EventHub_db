import { Controller, Get, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator';
import { AccessTier } from '../delegate/entities/delegate.entity';
import { AdminDashboardService } from './admin-dashboard.service';
import { AdminService } from './admin.service';
import { EditionScoped } from '../common/edition-scope/edition-scope.decorator';

@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin')
export class AdminController {
  constructor(
    private readonly service: AdminService,
    private readonly dashboardService: AdminDashboardService,
  ) {}

  @Get('overview')
  @Roles(AccessTier.ADMIN)
  @ApiOperation({ summary: 'Overview dashboard' })
  overview() {
    return this.service.overview();
  }

  @Get('dashboard')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'query', key: 'editionId' })
  @ApiOperation({
    summary: 'Organiser dashboard: sales, holders, engagement, activity',
  })
  @ApiQuery({
    name: 'editionId',
    required: false,
    description: 'Defaults to the current edition (drafts included)',
  })
  dashboard(
    @Query('editionId', new ParseUUIDPipe({ optional: true }))
    editionId?: string,
  ) {
    return this.dashboardService.dashboard(editionId);
  }
}
