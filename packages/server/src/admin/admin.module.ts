import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ReportingPeriodsModule } from '../reporting-periods/reporting-periods.module';
import { AuditFindingsModule } from '../audit-findings/audit-findings.module';
import { AuthModule } from '../auth/auth.module';
import { BankModule } from '../bank/bank.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { BankDuplicateRepairService } from './bank-duplicate-repair.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({
  // AuthModule provides ApiTokenService for AdminController's token routes (PR #38).
  imports: [
    DatabaseModule,
    ReportingPeriodsModule,
    AuditFindingsModule,
    AuthModule,
    BankModule,
    AuditLogModule,
  ],
  // Token provisioning lives in AdminController (PR #38). This branch adds the
  // settings surface (SettingsController/SettingsService). No separate
  // TokensController — it would collide with AdminController's /admin/tokens routes.
  controllers: [AdminController, SettingsController],
  providers: [AdminService, SettingsService, BankDuplicateRepairService],
  exports: [SettingsService],
})
export class AdminModule {}
