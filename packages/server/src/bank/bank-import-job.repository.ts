import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely, Selectable } from 'kysely';
import { Database, BankImportJobTable } from '../database/types';

export interface BankImportJob {
  id: number;
  status: string;
  account_code: string;
  statement_id: number | null;
  error: string | null;
  /** Parsed import summary (issue #399) when status is done, else null. */
  summary: {
    newCount: number;
    newTransactionIds: number[];
    knownCount: number;
    knownTransactionIds: number[];
    conflictCount: number;
    conflicts: {
      id: number;
      kind: string;
      external_id: string;
      statement_id: number;
      source_row_number: number | null;
    }[];
  } | null;
  created_at: number;
  updated_at: number;
}

@Injectable()
export class BankImportJobRepository {
  constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

  /** Create a new import job in 'running' state. */
  async create(accountCode: string): Promise<BankImportJob> {
    const now = Math.floor(Date.now() / 1000);
    const row = await this.db
      .insertInto('bank_import_job')
      .values({
        status: 'running',
        account_code: accountCode,
        statement_id: null,
        error: null,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.mapRow(row);
  }

  /** Get a single job by id; returns null if not found. */
  async get(id: number): Promise<BankImportJob | null> {
    const row = await this.db
      .selectFrom('bank_import_job')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? this.mapRow(row) : null;
  }

  /** Mark a job as done, recording the resulting statement_id and the
   *  import's new/known/conflict summary (issue #399). */
  async markDone(
    id: number,
    statementId: number,
    summary?: {
      newCount: number;
      knownCount: number;
      conflictCount: number;
      conflicts: unknown[];
    },
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.db
      .updateTable('bank_import_job')
      .set({
        status: 'done',
        statement_id: statementId,
        summary: summary ? JSON.stringify(summary) : null,
        updated_at: now,
      })
      .where('id', '=', id)
      .execute();
  }

  /** Mark a job as failed, recording the error message. */
  async markFailed(id: number, error: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.db
      .updateTable('bank_import_job')
      .set({ status: 'failed', error, updated_at: now })
      .where('id', '=', id)
      .execute();
  }

  private mapRow(row: Selectable<BankImportJobTable>): BankImportJob {
    let summary: BankImportJob['summary'] = null;
    if (row.summary) {
      try {
        summary = JSON.parse(row.summary);
      } catch {
        summary = null;
      }
    }
    return {
      id: row.id,
      status: row.status,
      account_code: row.account_code,
      statement_id: row.statement_id,
      error: row.error,
      summary,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
