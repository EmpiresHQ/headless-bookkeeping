import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AccountModule } from '../ledger/account/account.module';
import { VatReportController } from './vat-report.controller';
import { VatReportService } from './vat-report.service';

@Module({
  imports: [DatabaseModule, AccountModule],
  controllers: [VatReportController],
  providers: [VatReportService],
  exports: [VatReportService],
})
export class VatReportModule {}
