import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { BankModule } from '../bank/bank.module';
import { EntitiesModule } from '../entities/entities.module';
import { AccountModule } from '../ledger/account/account.module';
import { PostingModule } from '../ledger/posting/posting.module';
import { PluginsModule } from '../plugins/plugins.module';
import { OrganizationModule } from '../organization/organization.module';
import { ReconciliationService } from './reconciliation.service';
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
    PluginsModule,
    OrganizationModule,
  ],
  providers: [
    ReconciliationService,
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
