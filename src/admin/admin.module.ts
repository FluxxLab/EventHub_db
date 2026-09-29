import { Module } from '@nestjs/common';
import { StorageService } from '../common/storage/storage.service';
import { DelegateModule } from '../delegate/delegate.module';
import { EditionsModule } from '../editions/editions.module';
import { SessionsModule } from '../sessions/sessions.module';
import { VotingModule } from '../voting/voting.module';
import { AdminController } from './admin.controller';
import { AdminDashboardService } from './admin-dashboard.service';
import { AdminService } from './admin.service';

@Module({
  imports: [
    DelegateModule,
    SessionsModule,
    VotingModule,
    // the dashboard's default edition; EditionsModule never reaches back here
    EditionsModule,
  ],
  controllers: [AdminController],
  // StorageService signs recent delegates' avatars, as the directory does
  providers: [AdminService, AdminDashboardService, StorageService],
})
export class AdminModule {}
