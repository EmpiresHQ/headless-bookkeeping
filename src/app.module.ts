import { Module } from '@nestjs/common';
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
import { CorrectionsModule } from './corrections/corrections.module';
import { TriageModule } from './triage/triage.module';

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
    CorrectionsModule,
    TriageModule,
  ],
})
export class AppModule {}
