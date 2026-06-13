import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { StatutorySubmissionService } from './statutory-submission.service';
import { StatutorySubmissionController } from './statutory-submission.controller';

@Module({
  imports: [DatabaseModule, AuditLogModule],
  controllers: [StatutorySubmissionController],
  providers: [StatutorySubmissionService],
  exports: [StatutorySubmissionService],
})
export class StatutorySubmissionModule {}
