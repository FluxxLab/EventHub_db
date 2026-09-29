import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageService } from '../common/storage/storage.service';
import { Delegate } from '../delegate/entities/delegate.entity';
import { EditionsModule } from '../editions/editions.module';
import { EventReview } from './entities/event-review.entity';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';

/**
 * Event reviews on the app's event page. Edition cards read the aggregate
 * straight from the table (EditionsService.ratings), so nothing depends on
 * this module and it can depend on EditionsModule without a cycle.
 */
@Module({
  imports: [TypeOrmModule.forFeature([EventReview, Delegate]), EditionsModule],
  controllers: [ReviewsController],
  providers: [ReviewsService, StorageService],
})
export class ReviewsModule {}
