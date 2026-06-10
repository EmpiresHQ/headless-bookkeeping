import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AccountModule } from '../ledger/account/account.module';
import { OrganizationModule } from '../organization/organization.module';
import { VatReportModule } from '../vat-report/vat-report.module';
import { AuditFindingsModule } from '../audit-findings/audit-findings.module';
import { StatutoryReportService } from './statutory-report.service';

/**
 * StatutoryReportModule — wires the read-only statutory-report projection.
 *
 * Imports the modules that EXPORT its collaborators:
 *  - AccountModule         → LedgerBalanceService (the sign primitive)
 *  - VatReportModule       → VatReportService (authoritative boxes/totals)
 *  - OrganizationModule    → OrgContextResolver (active plugin + declarant)
 *  - AuditFindingsModule   → AuditFindingsService (warning → finding)
 */
@Module({
  imports: [
    DatabaseModule,
    AccountModule,
    VatReportModule,
    OrganizationModule,
    AuditFindingsModule,
  ],
  providers: [StatutoryReportService],
  exports: [StatutoryReportService],
})
export class StatutoryReportModule {}
