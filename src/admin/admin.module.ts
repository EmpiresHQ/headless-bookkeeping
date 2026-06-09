import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ReportingPeriodsModule } from '../reporting-periods/reporting-periods.module';
import { AuthModule } from '../auth/auth.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { TokensController } from './tokens.controller';

@Module({
  imports: [DatabaseModule, ReportingPeriodsModule, AuthModule],
  controllers: [AdminController, SettingsController, TokensController],
  providers: [AdminService, SettingsService],
})
export class AdminModule {}
