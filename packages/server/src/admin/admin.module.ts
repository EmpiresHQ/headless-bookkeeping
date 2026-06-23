import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ReportingPeriodsModule } from '../reporting-periods/reporting-periods.module';
import { AuthModule } from '../auth/auth.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({
  // AuthModule provides ApiTokenService for AdminController's token routes (PR #38).
  imports: [DatabaseModule, ReportingPeriodsModule, AuthModule],
  // Token provisioning lives in AdminController (PR #38). This branch adds the
  // settings surface (SettingsController/SettingsService). No separate
  // TokensController — it would collide with AdminController's /admin/tokens routes.
  controllers: [AdminController, SettingsController],
  providers: [AdminService, SettingsService],
  exports: [SettingsService],
})
export class AdminModule {}
