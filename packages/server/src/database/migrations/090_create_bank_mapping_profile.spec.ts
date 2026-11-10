import { Kysely, SqliteDialect, sql } from 'kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';
import * as m090 from './090_create_bank_mapping_profile';

/**
 * Exercise migration 090 directly on a fresh database. Running it in isolation
 * (rather than through the whole migration chain) keeps this contract test
 * focused: the table/documented columns, the unique key, and a working down.
 * `index.ts` registration is asserted separately below.
 */
describe('migration 090 — bank mapping profile', () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });
    await m090.up(db);
  });

  afterEach(async () => db.destroy());

  async function insert(headerHash: string) {
    return db
      .insertInto('bank_mapping_profile')
      .values({
        account_code: 'BANK_EUR',
        header_hash: headerHash,
        header_json: JSON.stringify(['Date', 'Amount']),
        ruleset_json: JSON.stringify({ account_code: 'BANK_EUR' }),
        source_job_id: 22,
        created_at: 1,
        last_used_at: 1,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  it('is registered in the migrations index', () => {
    expect(migrations['090_create_bank_mapping_profile']).toBe(m090);
  });

  it('creates the table with the documented columns and defaults', async () => {
    const row = await insert('hash-a');
    expect(row.id).toBeDefined();
    expect(row.account_code).toBe('BANK_EUR');
    expect(row.header_hash).toBe('hash-a');
    expect(row.header_json).toBe('["Date","Amount"]');
    expect(row.ruleset_json).toBe('{"account_code":"BANK_EUR"}');
    expect(row.source_job_id).toBe(22);
    expect(row.created_at).toBe(1);
    expect(row.last_used_at).toBe(1);
  });

  it('creates the unique (account_code, header_hash) index', async () => {
    const indexes = await sql<{ name: string }>`
      select name from sqlite_master
      where type = 'index' and tbl_name = 'bank_mapping_profile'
    `.execute(db);
    expect(indexes.rows.map((r) => r.name)).toContain(
      'bank_mapping_profile_account_header_unique',
    );
  });

  it('enforces the unique (account_code, header_hash) key', async () => {
    await insert('hash-a');
    let message = '';
    try {
      await insert('hash-a');
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/UNIQUE constraint failed/);
  });

  it('allows the same header hash for a different account', async () => {
    await insert('hash-a');
    const row = await db
      .insertInto('bank_mapping_profile')
      .values({
        account_code: 'BANK_USD',
        header_hash: 'hash-a',
        header_json: '[]',
        ruleset_json: '{}',
        source_job_id: null,
        created_at: 1,
        last_used_at: 1,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    expect(row.id).toBeDefined();
  });

  it('down drops the table', async () => {
    await m090.down(db);
    let message = '';
    try {
      await insert('hash-a');
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/no such table/i);
  });
});
