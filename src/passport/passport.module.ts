import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EditionsModule } from '../editions/editions.module';
import { BoothStamp } from './entities/booth-stamp.entity';
import { Booth } from './entities/booth.entity';
import { PassportController } from './passport.controller';
import { PassportService } from './passport.service';

@Module({
  imports: [TypeOrmModule.forFeature([Booth, BoothStamp]), EditionsModule],
  controllers: [PassportController],
  providers: [PassportService],
  exports: [PassportService],
})
export class PassportModule {}
