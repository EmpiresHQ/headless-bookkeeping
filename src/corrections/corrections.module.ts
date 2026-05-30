import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { PostingModule } from '../ledger/posting/posting.module';
import { VoucherModule } from '../ledger/voucher/voucher.module';
import { AccountModule } from '../ledger/account/account.module';
import { ExpensesModule } from '../expenses/expenses.module';
import { SalesInvoicesModule } from '../sales-invoices/sales-invoices.module';
import { CorrectionsService } from './corrections.service';
import { CorrectionsController } from './corrections.controller';

@Module({
  imports: [
    DatabaseModule,
    PostingModule,
    VoucherModule,
    AccountModule,
    ExpensesModule,
    SalesInvoicesModule,
  ],
  controllers: [CorrectionsController],
  providers: [CorrectionsService],
  exports: [CorrectionsService],
})
export class CorrectionsModule {}
