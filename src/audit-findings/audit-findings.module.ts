import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuditFindingsService } from './audit-findings.service';
import { AuditFindingsController } from './audit-findings.controller';

@Module({
  imports: [DatabaseModule],
  providers: [AuditFindingsService],
  controllers: [AuditFindingsController],
  exports: [AuditFindingsService],
})
export class AuditFindingsModule {}
