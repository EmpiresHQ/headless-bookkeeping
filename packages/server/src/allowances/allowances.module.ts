import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { BusinessTripService } from './business-trip.service';
import { BusinessTripController } from './business-trip.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [BusinessTripController],
  providers: [BusinessTripService],
  exports: [BusinessTripService],
})
export class AllowancesModule {}
