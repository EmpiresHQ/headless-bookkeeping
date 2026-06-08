import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AccountModule } from '../account/account.module';
import { LedgerValidationModule } from '../validation/ledger-validation.module';
import { PeriodLockModule } from '../../reporting-periods/period-lock.module';
import { PostingService } from './posting.service';

@Module({
  imports: [
    DatabaseModule,
    AccountModule,
    LedgerValidationModule,
    PeriodLockModule,
  ],
  providers: [PostingService],
  exports: [PostingService],
})
export class PostingModule {}
