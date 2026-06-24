import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { PluginsModule } from '../plugins/plugins.module';
import { OrganizationModule } from '../organization/organization.module';
import { BusinessTripService } from './business-trip.service';
import { BusinessTripController } from './business-trip.controller';
import { AllowanceLimitService } from './allowance-limit.service';
import { AllowanceService } from './allowance.service';
import { AllowanceController } from './allowance.controller';
import { AllowanceProjectionService } from './allowance-projection.service';

@Module({
  imports: [DatabaseModule, PluginsModule, OrganizationModule],
  controllers: [BusinessTripController, AllowanceController],
  providers: [BusinessTripService, AllowanceLimitService, AllowanceService, AllowanceProjectionService],
  exports: [BusinessTripService, AllowanceLimitService, AllowanceService, AllowanceProjectionService],
})
export class AllowancesModule {}
