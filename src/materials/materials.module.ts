import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageService } from '../common/storage/storage.service';
import { SessionsModule } from '../sessions/sessions.module';
import { SessionMaterial } from './entities/session-material.entity';
import { MaterialsController } from './materials.controller';
import { MaterialsService } from './materials.service';

/**
 * Session materials (post-summit report, XV.3). StorageService is provided
 * per module, as sessions and delegates do, and signs stored keys on read.
 */
@Module({
  imports: [TypeOrmModule.forFeature([SessionMaterial]), SessionsModule],
  controllers: [MaterialsController],
  providers: [MaterialsService, StorageService],
  exports: [MaterialsService],
})
export class MaterialsModule {}
