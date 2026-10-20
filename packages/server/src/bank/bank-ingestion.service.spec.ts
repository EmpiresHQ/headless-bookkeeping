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
import type { DocumentStorageService } from '../documents/document-storage.service';

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
  let savedRawSources: { id: number; filename: string; bytes: string }[];
  let storage: DocumentStorageService;
  let service: BankIngestionService;

  const forcedInput: CreateStatementInput = {
    account_code: 'BANK_EUR',
    start_date: '2026-01-01',
    end_date: '2026-01-31',
    transactions: [],
  };

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
      buildBankMappingAgent: () => Promise.resolve({}),
    } as unknown as MastraService;

    // Durable raw-source storage (issue #403): an in-memory stand-in for the
    // real filesystem seam, recording exactly what was saved. The service
    // saves in the BANK'S OWN namespace (bank-statements/), so an import
    // job's id can never collide with a real document's id.
    savedRawSources = [];
    storage = {
      saveNamespacedFile: async (
        _ns: string,
        id: number,
        filename: string,
        buffer: Buffer,
      ) => {
        savedRawSources.push({ id, filename, bytes: buffer.toString('utf8') });
        return `bank-statements/${id}/${filename}`;
      },
    } as unknown as DocumentStorageService;

    service = new BankIngestionService(mastra, statements, jobs, storage);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('startImport returns a jobId and synchronously records a running job', async () => {
    jest.spyOn(service, 'runWorkflow').mockResolvedValue(forcedInput);

    const { jobId } = await service.startImport(
      {
        text: 'csv-text',
        buffer: Buffer.from('csv-text'),
        filename: 'statement.csv',
      },
      'BANK_EUR',
    );

    expect(typeof jobId).toBe('number');
    const job = await jobs.get(jobId);
    expect(job?.status).toBe('running');
  });

  it('marks the job done, preserves the raw CSV durably and links it from the statement (issue #403)', async () => {
    jest.spyOn(service, 'runWorkflow').mockResolvedValue(forcedInput);

    const { jobId } = await service.startImport(
      {
        text: 'csv-text',
        buffer: Buffer.from('csv-text'),
        filename: 'statement.csv',
      },
      'BANK_EUR',
    );

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
    // The workflow output PLUS the durable raw-source link, in the bank's
    // own namespace (never the documents namespace a real document owns).
    expect(createStatement).toHaveBeenCalledWith({
      ...forcedInput,
      file_path: `bank-statements/${jobId}/statement.csv`,
    });
    // The ORIGINAL bytes were saved verbatim, once, under the job's id —
    // byte-exact, whatever the parsed text decodes from them.
    expect(savedRawSources).toEqual([
      { id: jobId, filename: 'statement.csv', bytes: 'csv-text' },
    ]);
  });

  it('archives its OWN byte-exact copy even for an already-durable intake upload (issue #403: the document’s lifetime must not govern the statement’s raw source)', async () => {
    jest.spyOn(service, 'runWorkflow').mockResolvedValue(forcedInput);

    // The upload arrived as an intake document whose bytes are already
    // stored — the import still archives its own bank-owned copy, so the
    // statement's raw source survives the document being deleted mid-import
    // or after.
    const { jobId } = await service.startImport(
      {
        text: 'csv-text',
        buffer: Buffer.from('csv-text'),
        filename: 'statement.csv',
      },
      'BANK_EUR',
    );
    for (let i = 0; i < 10; i++) {
      const job = await jobs.get(jobId);
      if (job?.status !== 'running') break;
      await flush();
    }
    expect(createStatement).toHaveBeenCalledWith({
      ...forcedInput,
      file_path: `bank-statements/${jobId}/statement.csv`,
    });
    expect(savedRawSources).toEqual([
      { id: jobId, filename: 'statement.csv', bytes: 'csv-text' },
    ]);
  });

  it('marks the job failed with the error message when runWorkflow rejects', async () => {
    jest.spyOn(service, 'runWorkflow').mockRejectedValue(new Error('boom'));

    const { jobId } = await service.startImport(
      {
        text: 'csv-text',
        buffer: Buffer.from('csv-text'),
        filename: 'statement.csv',
      },
      'BANK_EUR',
    );

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
