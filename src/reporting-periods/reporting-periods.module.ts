import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { VatReportModule } from '../vat-report/vat-report.module';
import { ReportingPeriodsController } from './reporting-periods.controller';
import { ReportingPeriodsService } from './reporting-periods.service';

@Module({
  imports: [DatabaseModule, VatReportModule],
  controllers: [ReportingPeriodsController],
  providers: [ReportingPeriodsService],
  exports: [ReportingPeriodsService],
})
export class ReportingPeriodsModule {}
