import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { PluginsModule } from '../plugins/plugins.module';
import { OrganizationModule } from '../organization/organization.module';
import { CurrencyModule } from '../currency/currency.module';
import { VoucherProjectionModule } from '../ledger/projection/voucher-projection.module';
import { AccountModule } from '../ledger/account/account.module';
import { PostingModule } from '../ledger/posting/posting.module';
import { RulesModule } from '../rules/rules.module';
import { PolicyModule } from '../policy/policy.module';
import { PostingPipelineModule } from '../ledger/pipeline/posting-pipeline.module';
import { SalesInvoicesController } from './sales-invoices.controller';
import { SalesInvoicesService } from './sales-invoices.service';

@Module({
  imports: [
    DatabaseModule,
    PluginsModule,
    OrganizationModule,
    CurrencyModule,
    VoucherProjectionModule,
    AccountModule,
    PostingModule,
    RulesModule,
    PolicyModule,
    PostingPipelineModule,
  ],
  controllers: [SalesInvoicesController],
  providers: [SalesInvoicesService],
  exports: [SalesInvoicesService],
})
export class SalesInvoicesModule {}
