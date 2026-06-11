import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { BankImportJobRepository } from './bank-import-job.repository';

describe('BankImportJobRepository (integration)', () => {
  let db: Kysely<Database>;
  let repo: BankImportJobRepository;

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
        BankImportJobRepository,
      ],
    }).compile();

    repo = module.get(BankImportJobRepository);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('create returns a running job with the correct account_code', async () => {
    const job = await repo.create('BANK_EUR');
    expect(job.id).toBeDefined();
    expect(job.status).toBe('running');
    expect(job.account_code).toBe('BANK_EUR');
    expect(job.statement_id).toBeNull();
    expect(job.error).toBeNull();
  });

  it('markDone updates status to done and sets statement_id', async () => {
    const job = await repo.create('BANK_EUR');
    await repo.markDone(job.id, 99);
    const updated = await repo.get(job.id);
    expect(updated?.status).toBe('done');
    expect(updated?.statement_id).toBe(99);
  });

  it('markFailed updates status to failed and sets error', async () => {
    const job = await repo.create('BANK_EUR');
    await repo.markFailed(job.id, 'boom');
    const updated = await repo.get(job.id);
    expect(updated?.status).toBe('failed');
    expect(updated?.error).toBe('boom');
  });

  it('get returns null for an unknown id', async () => {
    await expect(repo.get(9999)).resolves.toBeNull();
  });
});
