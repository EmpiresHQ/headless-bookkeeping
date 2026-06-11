import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { BankModule } from '../bank/bank.module';
import { EntitiesModule } from '../entities/entities.module';
import { AccountModule } from '../ledger/account/account.module';
import { PostingModule } from '../ledger/posting/posting.module';
import { PeriodLockModule } from '../reporting-periods/period-lock.module';
import { PluginsModule } from '../plugins/plugins.module';
import { CurrencyModule } from '../currency/currency.module';
import { OrganizationModule } from '../organization/organization.module';
import { ReconciliationService } from './reconciliation.service';
import { OutstandingVoucherService } from './outstanding-voucher.service';
import { ReconciliationController } from './reconciliation.controller';
import { PrepaymentService } from './prepayment.service';
import { PrepaymentController } from './prepayment.controller';
import { PersonalDispositionService } from './personal-disposition.service';
import { PersonalDispositionController } from './personal-disposition.controller';
import { FXRealizedService } from './fx-realized.service';
import { FXRealizedController } from './fx-realized.controller';

@Module({
  imports: [
    DatabaseModule,
    BankModule,
    EntitiesModule,
    AccountModule,
    PostingModule,
    PeriodLockModule,
    PluginsModule,
    CurrencyModule,
    OrganizationModule,
  ],
  providers: [
    ReconciliationService,
    OutstandingVoucherService,
    PrepaymentService,
    PersonalDispositionService,
    FXRealizedService,
  ],
  controllers: [
    ReconciliationController,
    PrepaymentController,
    PersonalDispositionController,
    FXRealizedController,
  ],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
