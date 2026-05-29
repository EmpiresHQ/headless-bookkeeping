import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { OrganizationModule } from '../organization/organization.module';
import { PluginsModule } from '../plugins/plugins.module';
import { AccountModule } from '../ledger/account/account.module';
import { PostingModule } from '../ledger/posting/posting.module';
import { RulesModule } from '../rules/rules.module';
import { PolicyModule } from '../policy/policy.module';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';

@Module({
  imports: [
    DatabaseModule,
    OrganizationModule,
    PluginsModule,
    AccountModule,
    PostingModule,
    RulesModule,
    PolicyModule,
  ],
  controllers: [ExpensesController],
  providers: [ExpensesService],
  exports: [ExpensesService],
})
export class ExpensesModule {}
