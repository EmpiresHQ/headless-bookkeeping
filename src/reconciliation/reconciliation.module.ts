import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { BankModule } from '../bank/bank.module';
import { EntitiesModule } from '../entities/entities.module';
import { AccountModule } from '../ledger/account/account.module';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationController } from './reconciliation.controller';

@Module({
  imports: [DatabaseModule, BankModule, EntitiesModule, AccountModule],
  providers: [ReconciliationService],
  controllers: [ReconciliationController],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
