import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ReportingPeriodsModule } from '../reporting-periods/reporting-periods.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({
  imports: [DatabaseModule, ReportingPeriodsModule],
  controllers: [AdminController, SettingsController],
  providers: [AdminService, SettingsService],
})
export class AdminModule {}
