import { Module } from '@nestjs/common';
import { DelegateModule } from '../delegate/delegate.module';
import { SecurityModule } from '../security/security.module';
import { PassController } from './pass.controller';
import { PassService } from './pass.service';

/**
 * FR-07. Its own module rather than more of auth.service: authentication
 * proves who is calling the API, a pass identifies a person at a door, and the
 * two only looked alike while they shared a signing key. This is also where
 * check-in and zone access will land.
 */
@Module({
  imports: [DelegateModule, SecurityModule],
  controllers: [PassController],
  providers: [PassService],
  exports: [PassService],
})
export class PassModule {}
