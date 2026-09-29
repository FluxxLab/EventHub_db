import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TicketingModule } from '../ticketing/ticketing.module';
import { MealCounter } from './entities/meal-counter.entity';
import { MealServing } from './entities/meal-serving.entity';
import { Meal } from './entities/meal.entity';
import { CounterController, MealsController } from './meals.controller';
import { MealsService } from './meals.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Meal, MealCounter, MealServing]),
    // AdmissionService: the ticket QR is checked with its signature
    TicketingModule,
  ],
  controllers: [MealsController, CounterController],
  providers: [MealsService],
})
export class MealsModule {}
