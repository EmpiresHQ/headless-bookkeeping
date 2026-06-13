import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { StatutorySubmissionService } from './statutory-submission.service';

@Module({
  imports: [DatabaseModule, AuditLogModule],
  providers: [StatutorySubmissionService],
  exports: [StatutorySubmissionService],
})
export class StatutorySubmissionModule {}
