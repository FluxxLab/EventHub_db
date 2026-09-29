import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { LiveOpsController } from './live-ops.controller';
import { LiveOpsService } from './live-ops.service';

@Module({
  imports: [SessionsModule],
  controllers: [LiveOpsController],
  providers: [LiveOpsService],
})
export class LiveOpsModule {}
