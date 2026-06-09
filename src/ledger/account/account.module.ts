import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { LedgerBalanceService } from './ledger-balance.service';

@Module({
  imports: [DatabaseModule],
  controllers: [AccountController],
  providers: [AccountService, LedgerBalanceService],
  exports: [AccountService, LedgerBalanceService],
})
export class AccountModule {}
