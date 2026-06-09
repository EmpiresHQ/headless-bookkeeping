import { Module } from '@nestjs/common';
import { APP_GUARD, APP_FILTER } from '@nestjs/core';
import { SqliteConstraintFilter } from './common/filters/sqlite-constraint.filter';
import { DatabaseModule } from './database/database.module';
import { OrganizationModule } from './organization/organization.module';
import { CurrencyModule } from './currency/currency.module';
import { PluginsModule } from './plugins/plugins.module';
import { HealthModule } from './health/health.module';
import { AccountModule } from './ledger/account/account.module';
import { VoucherModule } from './ledger/voucher/voucher.module';
import { ExpensesModule } from './expenses/expenses.module';
import { SalesInvoicesModule } from './sales-invoices/sales-invoices.module';
import { PolicyModule } from './policy/policy.module';
import { DocumentsModule } from './documents/documents.module';
import { CorrectionsModule } from './corrections/corrections.module';
import { TriageModule } from './triage/triage.module';
import { ReportingPeriodsModule } from './reporting-periods/reporting-periods.module';
import { EntitiesModule } from './entities/entities.module';
import { BankModule } from './bank/bank.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { AuditFindingsModule } from './audit-findings/audit-findings.module';
import { AgentsModule } from './agents/agents.module';
import { ConversationsModule } from './conversations/conversations.module';
import { DividendsModule } from './dividends/dividends.module';
import { AdminModule } from './admin/admin.module';
import { VatReportModule } from './vat-report/vat-report.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { AuthModule } from './auth/auth.module';
import { AiModule } from './ai/ai.module';
import { InteractionModule } from './interaction/interaction.module';
import { ApiTokenGuard } from './auth/api-token.guard';

@Module({
  imports: [
    DatabaseModule,
    OrganizationModule,
    CurrencyModule,
    PluginsModule,
    HealthModule,
    AccountModule,
    VoucherModule,
    ExpensesModule,
    SalesInvoicesModule,
    PolicyModule,
    DocumentsModule,
    CorrectionsModule,
    TriageModule,
    ReportingPeriodsModule,
    EntitiesModule,
    BankModule,
    ReconciliationModule,
    AuditFindingsModule,
    AgentsModule,
    ConversationsModule,
    DividendsModule,
    AdminModule,
    VatReportModule,
    ApprovalsModule,
    AuthModule,
    AiModule,
    InteractionModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ApiTokenGuard,
    },
    {
      // Map SQLite constraint violations (e.g. a non-existent FK) to clean 4xx
      // instead of an opaque 500. Applies app-wide (and in e2e).
      provide: APP_FILTER,
      useClass: SqliteConstraintFilter,
    },
  ],
})
export class AppModule {}
