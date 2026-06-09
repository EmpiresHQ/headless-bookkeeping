// src/audit-log/audit-log.module.ts
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuditLogService } from './audit-log.service';

@Module({
  imports: [DatabaseModule],
  providers: [AuditLogService],
  exports: [AuditLogService],
})
export class AuditLogModule {}
