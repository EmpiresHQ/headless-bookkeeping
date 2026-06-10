import { Module } from '@nestjs/common';
import { BankStatementService } from './bank-statement.service';
import { BankTransactionRepository } from './bank-transaction.repository';
import { BankImportJobRepository } from './bank-import-job.repository';
import { BankIngestionService } from './bank-ingestion.service';
import { BankStatementController } from './bank-statement.controller';
import { AccountModule } from '../ledger/account/account.module';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [AccountModule, AiModule],
  providers: [
    BankStatementService,
    BankTransactionRepository,
    BankImportJobRepository,
    BankIngestionService,
  ],
  controllers: [BankStatementController],
  exports: [
    BankStatementService,
    BankTransactionRepository,
    BankIngestionService,
  ],
})
export class BankModule {}
