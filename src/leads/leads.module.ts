import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EditionsModule } from '../editions/editions.module';
import { TicketingModule } from '../ticketing/ticketing.module';
import { BoothLeadKey } from './entities/booth-lead-key.entity';
import { BoothLead } from './entities/booth-lead.entity';
import { ExhibitorController, LeadsController } from './leads.controller';
import { LeadsReportController } from './leads-report.controller';
import { LeadsReportService } from './leads-report.service';
import { LeadsService } from './leads.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([BoothLead, BoothLeadKey]),
    EditionsModule,
    // AdmissionService: the badge QR is checked with the ticket's signature
    TicketingModule,
  ],
  controllers: [LeadsController, ExhibitorController, LeadsReportController],
  providers: [LeadsService, LeadsReportService],
})
export class LeadsModule {}
