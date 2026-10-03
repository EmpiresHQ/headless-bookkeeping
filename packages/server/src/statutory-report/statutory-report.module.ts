import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AccountModule } from '../ledger/account/account.module';
import { OrganizationModule } from '../organization/organization.module';
import { VatReportModule } from '../vat-report/vat-report.module';
import { PluginsModule } from '../plugins/plugins.module';
import { AuditFindingsModule } from '../audit-findings/audit-findings.module';
import { PrepaymentFactsModule } from '../reconciliation/prepayment-facts.module';
import { StatutorySubmissionModule } from '../statutory-submission/statutory-submission.module';
import { StatutoryReportService } from './statutory-report.service';
import { StatutoryReportController } from './statutory-report.controller';

/**
 * StatutoryReportModule — wires the read-only statutory-report projection.
 *
 * Imports the modules that EXPORT its collaborators:
 *  - AccountModule         → LedgerBalanceService (the sign primitive)
 *  - VatReportModule       → VatReportService (authoritative boxes/totals)
 *  - PluginsModule         → PluginLoader (resolve the FROZEN jurisdiction of a
 *    replayed filing, not the organization's current one)
 *  - OrganizationModule    → OrgContextResolver (active plugin + declarant)
 *  - AuditFindingsModule   → AuditFindingsService (warning → finding)
 *  - StatutorySubmissionModule → StatutorySubmissionService (which frozen
 *    filing-payload version the period's filing state pins)
 */
@Module({
  imports: [
    DatabaseModule,
    AccountModule,
    VatReportModule,
    PluginsModule,
    OrganizationModule,
    AuditFindingsModule,
    StatutorySubmissionModule,
    PrepaymentFactsModule,
  ],
  controllers: [StatutoryReportController],
  providers: [StatutoryReportService],
  exports: [StatutoryReportService],
})
export class StatutoryReportModule {}
