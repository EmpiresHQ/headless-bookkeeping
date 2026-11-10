import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { BankMappingProfileRepository } from './bank-mapping-profile.repository';
import type { MappingRuleset } from './bank-mapping.types';

const ruleset: MappingRuleset = {
  account_code: 'BANK_EUR',
  date_column: 'Date',
  date_format: 'YYYY-MM-DD',
  amount: {
    mode: 'debit_credit',
    amount_column: 'Amount',
    indicator_column: 'D/C',
    debit_value: 'D',
  },
  currency_column: 'Currency',
  default_currency: 'EUR',
  description_column: 'Explanation',
  counterparty_iban_column: null,
  counterparty_descriptor_column: null,
  reference_column: null,
};

const HEADER = ['Date', 'Amount', 'D/C', 'Currency', 'Explanation'];

describe('BankMappingProfileRepository (integration)', () => {
  let db: Kysely<Database>;
  let repo: BankMappingProfileRepository;

  beforeEach(async () => {
    const rawDb = new SqliteDb(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: rawDb }),
    });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error)
      throw error instanceof Error ? error : new Error('Migration failed');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        BankMappingProfileRepository,
      ],
    }).compile();

    repo = module.get(BankMappingProfileRepository);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('find returns null when no profile exists', async () => {
    await expect(repo.find('BANK_EUR', 'hash-a')).resolves.toBeNull();
    await expect(repo.findProfile('BANK_EUR', 'hash-a')).resolves.toBeNull();
  });

  it('save then find returns the stored ruleset', async () => {
    const saved = await repo.save({
      accountCode: 'BANK_EUR',
      headerHash: 'hash-a',
      headerColumns: HEADER,
      ruleset,
      sourceJobId: 22,
    });

    expect(saved.id).toBeDefined();
    expect(saved.header_json).toBe(JSON.stringify(HEADER));
    expect(saved.source_job_id).toBe(22);
    await expect(repo.find('BANK_EUR', 'hash-a')).resolves.toEqual(ruleset);
    const found = await repo.findProfile('BANK_EUR', 'hash-a');
    expect(found?.ruleset).toEqual(ruleset);
    expect(found?.created_at).toBe(saved.created_at);
    expect(found?.last_used_at).toBe(saved.last_used_at);
  });

  it('upserts on the (account_code, header_hash) unique key instead of duplicating', async () => {
    const first = await repo.save({
      accountCode: 'BANK_EUR',
      headerHash: 'hash-a',
      headerColumns: HEADER,
      ruleset,
    });
    const changed: MappingRuleset = { ...ruleset, default_currency: 'USD' };
    const second = await repo.save({
      accountCode: 'BANK_EUR',
      headerHash: 'hash-a',
      headerColumns: HEADER,
      ruleset: changed,
      sourceJobId: 23,
    });

    expect(second.id).toBe(first.id);
    expect(second.created_at).toBe(first.created_at);
    expect(second.source_job_id).toBe(23);
    await expect(repo.list('BANK_EUR')).resolves.toHaveLength(1);
    await expect(repo.find('BANK_EUR', 'hash-a')).resolves.toEqual(changed);
  });

  it('keys profiles by account as well as header hash', async () => {
    await repo.save({
      accountCode: 'BANK_EUR',
      headerHash: 'hash-a',
      headerColumns: HEADER,
      ruleset,
    });
    await expect(repo.find('BANK_USD', 'hash-a')).resolves.toBeNull();
  });

  it('find returns null for a ruleset that no longer parses', async () => {
    await db
      .insertInto('bank_mapping_profile')
      .values({
        account_code: 'BANK_EUR',
        header_hash: 'broken',
        header_json: JSON.stringify(HEADER),
        ruleset_json: '{"not":"a ruleset"}',
        source_job_id: null,
        created_at: 1,
        last_used_at: 1,
      })
      .execute();

    await expect(repo.find('BANK_EUR', 'broken')).resolves.toBeNull();
    await expect(repo.findProfile('BANK_EUR', 'broken')).resolves.toBeNull();
  });

  it('touch updates last_used_at', async () => {
    const saved = await repo.save({
      accountCode: 'BANK_EUR',
      headerHash: 'hash-a',
      headerColumns: HEADER,
      ruleset,
    });
    await db
      .updateTable('bank_mapping_profile')
      .set({ last_used_at: 1 })
      .where('id', '=', saved.id)
      .execute();

    await repo.touch(saved.id);
    const touched = await repo.findProfile('BANK_EUR', 'hash-a');
    expect(touched?.last_used_at).toBeGreaterThan(1);
  });

  it('delete removes one profile by its natural key', async () => {
    await repo.save({
      accountCode: 'BANK_EUR',
      headerHash: 'hash-a',
      headerColumns: HEADER,
      ruleset,
    });
    await expect(repo.delete('BANK_EUR', 'hash-a')).resolves.toBe(1);
    await expect(repo.find('BANK_EUR', 'hash-a')).resolves.toBeNull();
    await expect(repo.delete('BANK_EUR', 'hash-a')).resolves.toBe(0);
  });

  it('deleteById removes one profile by id', async () => {
    const saved = await repo.save({
      accountCode: 'BANK_EUR',
      headerHash: 'hash-a',
      headerColumns: HEADER,
      ruleset,
    });
    await expect(repo.deleteById(saved.id)).resolves.toBe(1);
    await expect(repo.deleteById(saved.id)).resolves.toBe(0);
  });

  it('list returns lightweight rows, optionally filtered by account', async () => {
    await repo.save({
      accountCode: 'BANK_EUR',
      headerHash: 'hash-a',
      headerColumns: HEADER,
      ruleset,
      sourceJobId: 1,
    });
    await repo.save({
      accountCode: 'BANK_USD',
      headerHash: 'hash-b',
      headerColumns: HEADER,
      ruleset,
    });

    const all = await repo.list();
    expect(all).toHaveLength(2);
    expect(all[0]).toEqual({
      id: expect.any(Number),
      account_code: 'BANK_EUR',
      header_json: JSON.stringify(HEADER),
      source_job_id: 1,
      created_at: expect.any(Number),
      last_used_at: expect.any(Number),
    });
    expect(all[0]).not.toHaveProperty('ruleset');

    const eur = await repo.list('BANK_EUR');
    expect(eur).toHaveLength(1);
    expect(eur[0].account_code).toBe('BANK_EUR');
  });
});
