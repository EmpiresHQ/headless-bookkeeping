import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AccountModule } from '../account/account.module';
import { LedgerValidationModule } from '../validation/ledger-validation.module';
import { PeriodLockModule } from '../../reporting-periods/period-lock.module';
import { RulesModule } from '../../rules/rules.module';
import { PostingService } from './posting.service';

@Module({
  imports: [
    DatabaseModule,
    AccountModule,
    LedgerValidationModule,
    PeriodLockModule,
    RulesModule,
  ],
  providers: [PostingService],
  exports: [PostingService],
})
export class PostingModule {}
