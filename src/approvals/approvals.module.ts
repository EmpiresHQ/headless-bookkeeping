import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AccountModule } from '../ledger/account/account.module';
import { PostingModule } from '../ledger/posting/posting.module';
import { StatusTransitionModule } from '../ledger/status/status-transition.module';
import { LedgerValidationModule } from '../ledger/validation/ledger-validation.module';
import { ExpensesModule } from '../expenses/expenses.module';
import { SalesInvoicesModule } from '../sales-invoices/sales-invoices.module';
import { ApprovalsService } from './approvals.service';
import { ApprovalsController } from './approvals.controller';

@Module({
  imports: [
    DatabaseModule,
    AccountModule,
    PostingModule,
    StatusTransitionModule,
    LedgerValidationModule,
    ExpensesModule,
    SalesInvoicesModule,
  ],
  providers: [ApprovalsService],
  controllers: [ApprovalsController],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
