import { Module } from '@nestjs/common';
import { BankStatementService } from './bank-statement.service';
import { BankTransactionRepository } from './bank-transaction.repository';
import { BankStatementController } from './bank-statement.controller';
import { AccountModule } from '../ledger/account/account.module';

@Module({
  imports: [AccountModule],
  providers: [BankStatementService, BankTransactionRepository],
  controllers: [BankStatementController],
  exports: [BankStatementService, BankTransactionRepository],
})
export class BankModule {}
