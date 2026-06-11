import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { PostingModule } from '../ledger/posting/posting.module';
import { VoucherModule } from '../ledger/voucher/voucher.module';
import { AccountModule } from '../ledger/account/account.module';
import { PeriodLockModule } from '../reporting-periods/period-lock.module';
import { CreditNotesService } from './credit-notes.service';
import { CreditNotesController } from './credit-notes.controller';

@Module({
  imports: [
    DatabaseModule,
    PostingModule,
    VoucherModule,
    AccountModule,
    PeriodLockModule,
  ],
  controllers: [CreditNotesController],
  providers: [CreditNotesService],
  exports: [CreditNotesService],
})
export class CreditNotesModule {}
