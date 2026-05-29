import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AccountModule } from '../account/account.module';
import { LedgerValidationService } from '../validation/ledger-validation.service';
import { PostingService } from './posting.service';

@Module({
  imports: [DatabaseModule, AccountModule],
  providers: [LedgerValidationService, PostingService],
  exports: [PostingService],
})
export class PostingModule {}
