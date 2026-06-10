import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { PostingModule } from '../ledger/posting/posting.module';
import { VoucherModule } from '../ledger/voucher/voucher.module';
import { AccountModule } from '../ledger/account/account.module';
import { PeriodLockModule } from '../reporting-periods/period-lock.module';
import { CreditNotesService } from './credit-notes.service';

@Module({
  imports: [
    DatabaseModule,
    PostingModule,
    VoucherModule,
    AccountModule,
    PeriodLockModule,
  ],
  providers: [CreditNotesService],
  exports: [CreditNotesService],
})
export class CreditNotesModule {}
