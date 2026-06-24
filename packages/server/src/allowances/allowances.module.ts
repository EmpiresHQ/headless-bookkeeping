import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { PluginsModule } from '../plugins/plugins.module';
import { BusinessTripService } from './business-trip.service';
import { BusinessTripController } from './business-trip.controller';
import { AllowanceLimitService } from './allowance-limit.service';

@Module({
  imports: [DatabaseModule, PluginsModule],
  controllers: [BusinessTripController],
  providers: [BusinessTripService, AllowanceLimitService],
  exports: [BusinessTripService, AllowanceLimitService],
})
export class AllowancesModule {}
