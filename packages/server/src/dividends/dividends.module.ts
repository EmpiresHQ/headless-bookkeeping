import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AccountModule } from '../ledger/account/account.module';
import { PostingModule } from '../ledger/posting/posting.module';
import { PluginsModule } from '../plugins/plugins.module';
import { OrganizationModule } from '../organization/organization.module';
import { CurrencyModule } from '../currency/currency.module';
import { BankModule } from '../bank/bank.module';
import { DividendsService } from './dividends.service';
import { DividendsController } from './dividends.controller';

@Module({
  imports: [
    DatabaseModule,
    AccountModule,
    PostingModule,
    PluginsModule,
    OrganizationModule,
    CurrencyModule,
    BankModule,
  ],
  providers: [DividendsService],
  controllers: [DividendsController],
})
export class DividendsModule {}
