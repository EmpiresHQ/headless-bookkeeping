import { Module } from '@nestjs/common';
import { LedgerValidationService } from './ledger-validation.service';

@Module({
  providers: [LedgerValidationService],
  exports: [LedgerValidationService],
})
export class LedgerValidationModule {}
