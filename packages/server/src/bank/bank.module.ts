import { Module, forwardRef } from '@nestjs/common';
import { BankStatementService } from './bank-statement.service';
import { BankTransactionRepository } from './bank-transaction.repository';
import { BankImportJobRepository } from './bank-import-job.repository';
import { BankIngestionService } from './bank-ingestion.service';
import { BankStatementController } from './bank-statement.controller';
import { BankIngestionController } from './bank-ingestion.controller';
import { AccountModule } from '../ledger/account/account.module';
import { AiModule } from '../ai/ai.module';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';

@Module({
  // forwardRef on both AiModule and ReconciliationModule:
  //   AiModule ↔ BankModule: IntakeWorkflowService (AiModule) uses BankIngestionService
  //   ReconciliationModule ↔ BankModule: auto-stage on import
  imports: [AccountModule, forwardRef(() => AiModule), forwardRef(() => ReconciliationModule)],
  providers: [
    BankStatementService,
    BankTransactionRepository,
    BankImportJobRepository,
    BankIngestionService,
  ],
  controllers: [BankStatementController, BankIngestionController],
  exports: [
    BankStatementService,
    BankTransactionRepository,
    BankIngestionService,
  ],
})
export class BankModule {}
