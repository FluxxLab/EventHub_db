import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator';
import { EditionScoped } from '../common/edition-scope/edition-scope.decorator';
import { AccessTier } from '../delegate/entities/delegate.entity';
import { LeadsReportService } from './leads-report.service';

/** The exhibition report: counts per stand, over the day, for organisers and sponsors. */
@ApiTags('leads')
@Controller()
export class LeadsReportController {
  constructor(private readonly reports: LeadsReportService) {}

  @Get('editions/:editionId/leads/report')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'editionId' })
  @ApiOperation({
    summary:
      'Leads, interest, passport stamps and leads by hour for every stand; counts only, no personal details',
  })
  report(@Param('editionId', ParseUUIDPipe) editionId: string) {
    return this.reports.report(editionId);
  }
}
