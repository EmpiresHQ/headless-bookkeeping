import { Module } from '@nestjs/common';
import { LedgerValidationModule } from '../ledger/validation/ledger-validation.module';
import { PluginsModule } from '../plugins/plugins.module';
import { PeriodLockModule } from '../reporting-periods/period-lock.module';
import { RulesService } from './rules.service';

@Module({
  imports: [LedgerValidationModule, PluginsModule, PeriodLockModule],
  providers: [RulesService],
  exports: [RulesService],
})
export class RulesModule {}
