import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ReportingPeriodsModule } from '../reporting-periods/reporting-periods.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminKeyGuard } from './admin-key.guard';

@Module({
  imports: [DatabaseModule, ReportingPeriodsModule],
  controllers: [AdminController],
  providers: [AdminKeyGuard, AdminService],
})
export class AdminModule {}
