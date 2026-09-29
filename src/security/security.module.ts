import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Delegate } from '../delegate/entities/delegate.entity';
import { SecurityEvent } from './entities/security-event.entity';
import { SecurityController } from './security.controller';
import { SecurityService } from './security.service';

@Global() // infrastructure-like: many modules write audit events
@Module({
  // Delegate: the log names who did each thing
  imports: [TypeOrmModule.forFeature([SecurityEvent, Delegate])],
  controllers: [SecurityController],
  providers: [SecurityService],
  exports: [SecurityService],
})
export class SecurityModule {}
