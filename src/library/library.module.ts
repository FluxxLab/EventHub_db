import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageService } from '../common/storage/storage.service';
import { EditionsModule } from '../editions/editions.module';
import { LibraryController } from './library.controller';
import { LibraryItem } from './library-item.entity';
import { LibraryService } from './library.service';

@Module({
  imports: [TypeOrmModule.forFeature([LibraryItem]), EditionsModule],
  controllers: [LibraryController],
  // StorageService signs uploaded files, session materials and the Purple Book on read
  providers: [LibraryService, StorageService],
})
export class LibraryModule {}
