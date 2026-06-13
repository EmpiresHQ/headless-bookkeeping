import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AccountModule } from '../ledger/account/account.module';
import { OrganizationModule } from '../organization/organization.module';
import { PostingModule } from '../ledger/posting/posting.module';
import { ReportingPeriodsModule } from '../reporting-periods/reporting-periods.module';
import { AnnualAccountsController } from './annual-accounts.controller';
import { AnnualAccountsService } from './annual-accounts.service';

/**
 * AnnualAccountsModule — wires the annual-accounts projection (ADR-0034).
 * Imports the modules that EXPORT its collaborators:
 *  - AccountModule          → LedgerBalanceService (period balances)
 *  - OrganizationModule     → OrgContextResolver (active plugin + declarant)
 *  - PostingModule          → PostingService (final depreciation voucher)
 *  - ReportingPeriodsModule → ReportingPeriodsService (lock the year)
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
  ],
  controllers: [AnnualAccountsController],
  providers: [AnnualAccountsService],
  exports: [AnnualAccountsService],
})
export class AnnualAccountsModule {}
