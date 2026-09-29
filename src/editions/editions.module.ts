import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EditionsController } from './editions.controller';
import { EditionsService } from './editions.service';
import { StorageService } from '../common/storage/storage.service';
import { Edition } from './entities/edition.entity';
import { EditionRoom } from './entities/edition-room.entity';
import { EditionRoomsService } from './edition-rooms.service';
import { DelegateModule } from '../delegate/delegate.module';
import { CatalogModule } from '../catalog/catalog.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Edition, EditionRoom]),
    // the attendees list reuses the directory's rules and avatar signing;
    // DelegateModule imports nothing that leads back here, so no cycle
    DelegateModule,
    // an edition's tracks and interests are picked from the catalog's libraries
    CatalogModule,
  ],
  controllers: [EditionsController],
  providers: [EditionsService, EditionRoomsService, StorageService],
  exports: [EditionsService, EditionRoomsService],
})
export class EditionsModule {}
