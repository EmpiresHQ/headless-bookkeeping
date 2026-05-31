import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ReportingPeriodsController } from './reporting-periods.controller';
import { ReportingPeriodsService } from './reporting-periods.service';

@Module({
  imports: [DatabaseModule],
  controllers: [ReportingPeriodsController],
  providers: [ReportingPeriodsService],
  exports: [ReportingPeriodsService],
})
export class ReportingPeriodsModule {}
