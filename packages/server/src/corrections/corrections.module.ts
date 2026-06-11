import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { PostingModule } from '../ledger/posting/posting.module';
import { StatusTransitionModule } from '../ledger/status/status-transition.module';
import { VoucherModule } from '../ledger/voucher/voucher.module';
import { AccountModule } from '../ledger/account/account.module';
import { PeriodLockModule } from '../reporting-periods/period-lock.module';
import { ExpensesModule } from '../expenses/expenses.module';
import { SalesInvoicesModule } from '../sales-invoices/sales-invoices.module';
import { CreditNotesModule } from '../credit-notes/credit-notes.module';
import { CorrectionsService } from './corrections.service';
import { CorrectionsController } from './corrections.controller';

@Module({
  imports: [
    DatabaseModule,
    PostingModule,
    StatusTransitionModule,
    VoucherModule,
    AccountModule,
    PeriodLockModule,
    ExpensesModule,
    SalesInvoicesModule,
    CreditNotesModule,
  ],
  controllers: [CorrectionsController],
  providers: [CorrectionsService],
  exports: [CorrectionsService],
})
export class CorrectionsModule {}
