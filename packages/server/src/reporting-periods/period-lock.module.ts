import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { PeriodLockService } from './period-lock.service';

/**
 * Minimal module exposing the canonical period-lock check. Kept separate from
 * ReportingPeriodsModule (which pulls in VAT-report generation) so the posting,
 * rules, and corrections paths can depend on the lock check without dragging in
 * filing machinery or risking a dependency cycle.
 */
@Module({
  imports: [DatabaseModule],
  providers: [PeriodLockService],
  exports: [PeriodLockService],
})
export class PeriodLockModule {}
