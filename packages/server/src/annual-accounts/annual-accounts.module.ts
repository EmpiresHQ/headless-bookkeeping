import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AccountModule } from '../ledger/account/account.module';
import { OrganizationModule } from '../organization/organization.module';
import { PostingModule } from '../ledger/posting/posting.module';
import { ReportingPeriodsModule } from '../reporting-periods/reporting-periods.module';
import { AuditFindingsModule } from '../audit-findings/audit-findings.module';
import { FixedAssetsModule } from '../fixed-assets/fixed-assets.module';
import { AnnualAccountsController } from './annual-accounts.controller';
import { AnnualAccountsService } from './annual-accounts.service';

/**
 * AnnualAccountsModule — wires the annual-accounts projection (ADR-0034).
 * Imports the modules that EXPORT its collaborators:
 *  - AccountModule          → LedgerBalanceService (period balances)
 *  - OrganizationModule     → OrgContextResolver (active plugin + declarant)
 *  - PostingModule          → PostingService (final depreciation voucher)
 *  - ReportingPeriodsModule → ReportingPeriodsService (close/lock the year)
 *  - AuditFindingsModule    → AuditFindingsService (year-end-adjustment notice)
 *  - FixedAssetsModule      → DepreciationAttributionService (per-asset
 *                             attribution of the charge it posts, issue #208)
 *
 * The controller is added in Task 9.
 */
@Module({
  imports: [
    DatabaseModule,
    AccountModule,
    OrganizationModule,
    PostingModule,
    ReportingPeriodsModule,
    AuditFindingsModule,
    FixedAssetsModule,
  ],
  controllers: [AnnualAccountsController],
  providers: [AnnualAccountsService],
  exports: [AnnualAccountsService],
})
export class AnnualAccountsModule {}
