import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Delegate } from './entities/delegate.entity';
import { DelegatesService } from './delegates.service';
import { DelegateSeedService } from './seed/delegate-seed.service';
import { DelegatesGateway } from './delegates.gateway';
import { PresenceGateway } from './presence.gateway';
import { PresenceService } from './presence.service';
import { StorageService } from '../common/storage/storage.service';
import { RegistrationEntry } from './entities/registration-entry.entity';
import { DelegatesController } from './delegates.controller';
import { DelegateConnection } from './entities/delegate-connection.entity';
import { DirectMessage } from './entities/direct-message.entity';
import { MessageReaction } from './entities/message-reaction.entity';
import { DelegateBlock } from './entities/delegate-block.entity';
import { RealtimeModule } from '../common/realtime/realtime.module';
import { CatalogModule } from '../catalog/catalog.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Delegate,
      RegistrationEntry,
      DelegateConnection,
      DirectMessage,
      MessageReaction,
      DelegateBlock,
    ]),
    RealtimeModule,
    // PATCH /delegates/me checks interests against the managed list
    CatalogModule,
    // A connection raises a notification for the other delegate. Queued, not
    // called: NotificationsService already depends on this module.
    BullModule.registerQueue({ name: 'notifications' }),
  ],
  controllers: [DelegatesController],
  providers: [
    DelegatesService,
    DelegatesGateway,
    // who is online, across instances; the dashboard reads its count
    PresenceService,
    PresenceGateway,
    StorageService,
    // env-gated trickle of seeded delegates; a no-op unless SEED_DELEGATES_TARGET is set
    DelegateSeedService,
  ],
  exports: [DelegatesService, PresenceService],
})
export class DelegateModule {}
