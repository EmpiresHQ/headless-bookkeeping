import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AccountModule } from '../ledger/account/account.module';
import { PluginsModule } from '../plugins/plugins.module';
import { OrganizationModule } from '../organization/organization.module';
import { VatReportController } from './vat-report.controller';
import { VatReportService } from './vat-report.service';

@Module({
  imports: [DatabaseModule, AccountModule, PluginsModule, OrganizationModule],
  controllers: [VatReportController],
  providers: [VatReportService],
  exports: [VatReportService],
})
export class VatReportModule {}
