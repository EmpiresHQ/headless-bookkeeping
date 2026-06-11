// src/audit-log/audit-log.service.ts
import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { Database } from '../database/types';
import { AuditEntry } from './types';

@Injectable()
export class AuditLogService {
  constructor(
    @Inject(KYSELY_MODULE_CONNECTION_TOKEN())
    private readonly db: Kysely<Database>,
  ) {}

  private now(): number {
    return Math.floor(Date.now() / 1000);
  }

  /** The sole write path into the append-only audit_log (ADR-0026). */
  async record(entry: AuditEntry): Promise<void> {
    await this.db
      .insertInto('audit_log')
      .values({
        occurred_at: this.now(),
        actor: entry.actor,
        action: entry.action,
        outcome: entry.outcome,
        target_type: entry.target_type ?? null,
        target_id: entry.target_id ?? null,
        detail: entry.detail ? JSON.stringify(entry.detail) : null,
      })
      .execute();
  }
}
