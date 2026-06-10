import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { BankImportJobRepository } from './bank-import-job.repository';
import { BankIngestionService } from './bank-ingestion.service';
import type { CreateStatementInput } from './bank-statement.types';
import type { BankStatementService } from './bank-statement.service';
import type { MastraService } from '../ai/mastra.service';

/** Flush the microtask/macrotask queue so fire-and-forget work settles. */
async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

describe('BankIngestionService (integration)', () => {
  let db: Kysely<Database>;
  let jobs: BankImportJobRepository;
  let createStatement: jest.Mock;
  let statements: BankStatementService;
  let mastra: MastraService;
  let service: BankIngestionService;

  const forcedInput: CreateStatementInput = {
    account_code: 'BANK_EUR',
    start_date: '2026-01-01',
    end_date: '2026-01-31',
    transactions: [],
  } as CreateStatementInput;

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

    jobs = new BankImportJobRepository(db);

    createStatement = jest.fn().mockResolvedValue({ statement: { id: 99 } });
    statements = {
      createStatement,
    } as unknown as BankStatementService;

    mastra = {
      getBankMappingAgent: () => ({}),
    } as unknown as MastraService;

    service = new BankIngestionService(mastra, statements, jobs);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('startImport returns a jobId and synchronously records a running job', async () => {
    jest.spyOn(service, 'runWorkflow').mockResolvedValue(forcedInput);

    const { jobId } = await service.startImport('csv-text', 'BANK_EUR');

    expect(typeof jobId).toBe('number');
    const job = await jobs.get(jobId);
    expect(job?.status).toBe('running');
  });

  it('marks the job done with statement_id and calls createStatement with the workflow output', async () => {
    jest.spyOn(service, 'runWorkflow').mockResolvedValue(forcedInput);

    const { jobId } = await service.startImport('csv-text', 'BANK_EUR');

    // Let the fire-and-forget background task settle.
    for (let i = 0; i < 10; i++) {
      const job = await jobs.get(jobId);
      if (job?.status !== 'running') break;
      await flush();
    }

    const job = await service.getImportStatus(jobId);
    expect(job?.status).toBe('done');
    expect(job?.statement_id).toBe(99);
    expect(createStatement).toHaveBeenCalledTimes(1);
    expect(createStatement).toHaveBeenCalledWith(forcedInput);
  });

  it('marks the job failed with the error message when runWorkflow rejects', async () => {
    jest.spyOn(service, 'runWorkflow').mockRejectedValue(new Error('boom'));

    const { jobId } = await service.startImport('csv-text', 'BANK_EUR');

    for (let i = 0; i < 10; i++) {
      const job = await jobs.get(jobId);
      if (job?.status !== 'running') break;
      await flush();
    }

    const job = await service.getImportStatus(jobId);
    expect(job?.status).toBe('failed');
    expect(job?.error).toBe('boom');
    expect(createStatement).not.toHaveBeenCalled();
  });
});
