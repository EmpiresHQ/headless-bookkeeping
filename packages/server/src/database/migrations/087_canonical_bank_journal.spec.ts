import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';

/**
 * Issue #399: the canonical bank journal migration. Everything here is
 * SYNTHETIC fixture data — no production source was inspected or repaired.
 */
describe('migration 087 — canonical bank journal', () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error;
  });

  afterEach(async () => db.destroy());

  function now(): number {
    return Math.floor(Date.now() / 1000);
  }

  async function seedStatement(
    values: Partial<{
      account_id: number;
      provider_code: string | null;
      source_account_ref: string | null;
      content_hash: string | null;
    }>,
  ): Promise<number> {
    const row = await db
      .insertInto('bank_statement')
      .values({
        account_id: values.account_id ?? 2,
        start_date: '2026-06-01',
        end_date: '2026-06-30',
        uploaded_at: now(),
        file_path: null,
        provider_code: values.provider_code ?? null,
        source_account_ref: values.source_account_ref ?? null,
        content_hash: values.content_hash ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async function insertTxn(values: {
    statement_id: number | null;
    account_id?: number | null;
    provider_code?: string | null;
    source_account_ref?: string | null;
    external_id?: string | null;
    amount?: number;
  }): Promise<number> {
    const row = await db
      .insertInto('bank_transaction')
      .values({
        statement_id: values.statement_id,
        account_id: values.account_id ?? 2,
        provider_code: values.provider_code ?? null,
        source_account_ref: values.source_account_ref ?? null,
        external_id: values.external_id ?? null,
        transaction_date: '2026-06-09',
        description: 'Synthetic migration row',
        amount: values.amount ?? -1391,
        currency: 'EUR',
        status: 'open',
        created_at: now(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  it('backs legacy rows up with identity columns, provenance and account link', async () => {
    // Legacy rows exist BEFORE 087: migrate only through 086, insert them,
    // then upgrade — the migration backfills identity + provenance.
    const fresh = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });
    try {
      const migrator = new Migrator({
        db: fresh,
        provider: { getMigrations: () => Promise.resolve(migrations) },
      });
      const to086 = await migrator.migrateTo(
        '086_add_bank_transaction_fx_rate_decimals',
      );
      if (to086.error) throw to086.error;

      const statementRow = await fresh
        .insertInto('bank_statement')
        .values({
          account_id: 2,
          start_date: '2026-06-01',
          end_date: '2026-06-30',
          uploaded_at: now(),
          file_path: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const legacyTxn = await fresh
        .insertInto('bank_transaction')
        .values({
          statement_id: statementRow.id,
          transaction_date: '2026-06-09',
          amount: -1391,
          currency: 'EUR',
          status: 'open',
          created_at: now(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const upgraded = await migrator.migrateToLatest();
      if (upgraded.error) throw upgraded.error;

      const txn = await fresh
        .selectFrom('bank_transaction')
        .selectAll()
        .where('id', '=', legacyTxn.id)
        .executeTakeFirstOrThrow();
      expect(txn.statement_id).toBe(statementRow.id);
      expect(txn.account_id).toBe(2);
      // Legacy rows have no bank-provided ids (lost before 087) — NULL,
      // honestly, so they never merge.
      expect(txn.provider_code).toBeNull();
      expect(txn.external_id).toBeNull();

      const sources = await fresh
        .selectFrom('bank_transaction_source')
        .selectAll()
        .where('bank_transaction_id', '=', legacyTxn.id)
        .execute();
      expect(sources).toHaveLength(1);
      expect(sources[0].statement_id).toBe(statementRow.id);
      expect(sources[0].source_row_number).toBeNull();
    } finally {
      await fresh.destroy();
    }
  });

  it('enforces the canonical identity UNIQUE at storage level (concurrent/retry safety)', async () => {
    const statementA = await seedStatement({});
    const statementB = await seedStatement({});
    await insertTxn({
      statement_id: statementA,
      provider_code: 'LHV',
      source_account_ref: 'EE11SYNTHETIC',
      external_id: 'SYN-1',
    });
    await expect(
      insertTxn({
        statement_id: statementB,
        provider_code: 'LHV',
        source_account_ref: 'EE11SYNTHETIC',
        external_id: 'SYN-1',
      }),
    ).rejects.toThrow(/UNIQUE/i);

    // The same id on a DIFFERENT provider or source account is a different
    // movement — no index collision.
    await insertTxn({
      statement_id: statementB,
      provider_code: 'SEB',
      source_account_ref: 'EE11SYNTHETIC',
      external_id: 'SYN-1',
    });
    await insertTxn({
      statement_id: statementB,
      provider_code: 'LHV',
      source_account_ref: 'EE22SYNTHETIC',
      external_id: 'SYN-1',
    });
  });

  it('never merges unknown identity: multiple NULL-identity rows are allowed', async () => {
    const statementId = await seedStatement({});
    // Identity-less rows (no bank transaction id) stay distinct — genuine
    // repeated identical purchases are never collapsed by the schema.
    await insertTxn({ statement_id: statementId });
    await insertTxn({ statement_id: statementId });
    const rows = await db
      .selectFrom('bank_transaction')
      .select('id')
      .where('statement_id', '=', statementId)
      .execute();
    expect(rows).toHaveLength(2);
  });

  it('allows a NULL statement_id (a detached origin on a surviving canonical row)', async () => {
    // A canonical movement whose origin statement was deleted must survive —
    // the FK must not pin the movement to its dead origin.
    await insertTxn({ statement_id: null });
  });

  it('keeps the AUTOINCREMENT high-water mark across the upgrade (deleted highest legacy ids are never re-minted)', async () => {
    // Migrate only THROUGH 086, insert legacy rows, delete the highest, then
    // upgrade — the next id must skip the deleted historical id.
    const fresh = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });
    try {
      const migrator = new Migrator({
        db: fresh,
        provider: { getMigrations: () => Promise.resolve(migrations) },
      });
      const to086 = await migrator.migrateTo(
        '086_add_bank_transaction_fx_rate_decimals',
      );
      if (to086.error) throw to086.error;

      const stmt = (
        await fresh
          .insertInto('bank_statement')
          .values({
            account_id: 2,
            start_date: '2026-06-01',
            end_date: '2026-06-30',
            uploaded_at: now(),
            file_path: null,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      const id1 = (
        await fresh
          .insertInto('bank_transaction')
          .values({
            statement_id: stmt,
            transaction_date: '2026-06-09',
            amount: -1391,
            currency: 'EUR',
            status: 'open',
            created_at: now(),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      const id2 = (
        await fresh
          .insertInto('bank_transaction')
          .values({
            statement_id: stmt,
            transaction_date: '2026-06-10',
            amount: -100,
            currency: 'EUR',
            status: 'open',
            created_at: now(),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      // Delete the HIGHEST historical id (an already-imported duplicate).
      await fresh
        .deleteFrom('bank_transaction')
        .where('id', '=', id2)
        .execute();
      const beforeSeq = await fresh
        .selectFrom('sqlite_sequence' as never)
        .selectAll()
        .execute();
      expect(
        (beforeSeq as unknown as { name: string; seq: number }[]).find(
          (r) => r.name === 'bank_transaction',
        )?.seq,
      ).toBeGreaterThanOrEqual(id2);

      const upgraded = await migrator.migrateToLatest();
      if (upgraded.error) throw upgraded.error;

      const nextId = (
        await fresh
          .insertInto('bank_transaction')
          .values({
            statement_id: stmt,
            transaction_date: '2026-06-11',
            amount: -50,
            currency: 'EUR',
            status: 'open',
            created_at: now(),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      expect(nextId).toBeGreaterThan(id2);
      expect(nextId).not.toBe(id2);
      expect(id1).toBeGreaterThan(0);
    } finally {
      await fresh.destroy();
    }
  });

  it('creates the provenance, conflict, repair and alias tables', async () => {
    for (const table of [
      'bank_transaction_source',
      'bank_import_conflict',
      'bank_duplicate_repair',
      'bank_transaction_alias',
    ]) {
      const rows = await db
        .selectFrom(table as never)
        .selectAll()
        .execute();
      expect(rows).toEqual([]);
    }
    // The import job carries the summary column.
    const job = await db
      .insertInto('bank_import_job')
      .values({
        status: 'running',
        account_code: 'BANK_EUR',
        created_at: now(),
        updated_at: now(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    expect(job.summary).toBeNull();
  });
});
