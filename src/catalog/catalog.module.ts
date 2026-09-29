import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageService } from '../common/storage/storage.service';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { CategorySetting } from './entities/category-setting.entity';
import { InterestOption } from './entities/interest-option.entity';
import { TrackOption } from './entities/track-option.entity';
import { Edition } from '../editions/entities/edition.entity';

/**
 * API-managed reference data (24 Sep 2026). Imports no feature module, so
 * DelegateModule can import this one to validate interests without a cycle.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      InterestOption,
      CategorySetting,
      TrackOption,
      // reads editions' picks: the entity, not EditionsModule, so no cycle
      Edition,
    ]),
  ],
  controllers: [CatalogController],
  providers: [CatalogService, StorageService],
  exports: [CatalogService],
})
export class CatalogModule {}
