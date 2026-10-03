import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AccountModule } from '../ledger/account/account.module';
import { PluginsModule } from '../plugins/plugins.module';
import { OrganizationModule } from '../organization/organization.module';
import { VatReportController } from './vat-report.controller';
import { PrepaymentFactsModule } from '../reconciliation/prepayment-facts.module';
import { VatReportService } from './vat-report.service';

@Module({
  imports: [
    DatabaseModule,
    AccountModule,
    PluginsModule,
    OrganizationModule,
    // Reading what a customer advance IS, for the filing gate (issue #213).
    PrepaymentFactsModule,
  ],
  controllers: [VatReportController],
  providers: [VatReportService],
  exports: [VatReportService],
})
export class VatReportModule {}
