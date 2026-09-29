import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageService } from '../common/storage/storage.service';
import { EditionsModule } from '../editions/editions.module';
import { GalleryAlbum, GalleryPhoto } from './entities/gallery.entities';
import { GalleryController } from './gallery.controller';
import { GalleryService } from './gallery.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([GalleryAlbum, GalleryPhoto]),
    EditionsModule,
  ],
  controllers: [GalleryController],
  // StorageService signs the private photo files on every read
  providers: [GalleryService, StorageService],
})
export class GalleryModule {}
