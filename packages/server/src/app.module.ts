import { Module } from '@nestjs/common';
import { APP_GUARD, APP_FILTER } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
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
import { CreditNotesModule } from './credit-notes/credit-notes.module';
import { AuthModule } from './auth/auth.module';
import { AiModule } from './ai/ai.module';
import { InteractionModule } from './interaction/interaction.module';
import { StatutoryReportModule } from './statutory-report/statutory-report.module';
import { CategoriesModule } from './categories/categories.module';
import { ApiTokenGuard } from './auth/api-token.guard';

@Module({
  imports: [
    ServeStaticModule.forRoot({
      // Built SPA from the @headless-bookkeeping/web package, resolved via node
      // module resolution (cwd-independent; the server depends on web).
      rootPath: join(
        dirname(
          createRequire(__filename).resolve(
            '@headless-bookkeeping/web/package.json',
          ),
        ),
        'dist',
      ),
      // Never let static serving intercept the API / admin / health surfaces —
      // those must reach the global ApiTokenGuard (or the health route).
      // Note: @nestjs/serve-static v5 uses path-to-regexp v8 which no longer
      // supports bare `*` glob syntax; use `{/*any}` instead.
      exclude: ['/api{/*any}', '/admin{/*any}', '/health{/*any}'],
    }),
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
    CreditNotesModule,
    AuthModule,
    AiModule,
    InteractionModule,
    StatutoryReportModule,
    CategoriesModule,
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
