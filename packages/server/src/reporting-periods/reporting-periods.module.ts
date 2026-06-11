import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { VatReportModule } from '../vat-report/vat-report.module';
import { OrganizationModule } from '../organization/organization.module';
import { PluginsModule } from '../plugins/plugins.module';
import { ReportingPeriodsController } from './reporting-periods.controller';
import { ReportingPeriodsService } from './reporting-periods.service';

@Module({
  imports: [DatabaseModule, VatReportModule, OrganizationModule, PluginsModule],
  controllers: [ReportingPeriodsController],
  providers: [ReportingPeriodsService],
  exports: [ReportingPeriodsService],
})
export class ReportingPeriodsModule {}
