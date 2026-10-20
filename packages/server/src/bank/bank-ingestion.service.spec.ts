import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { BankImportJobRepository } from './bank-import-job.repository';
import { BankIngestionService } from './bank-ingestion.service';
import type { CreateStatementInput } from './bank-statement.types';
import { sourceFingerprint } from './apply-rules';
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

    createStatement = jest.fn().mockResolvedValue({
      statement: { id: 99 },
      summary: {
        newCount: 0,
        newTransactionIds: [],
        knownCount: 0,
        knownTransactionIds: [],
        conflictCount: 0,
        conflicts: [],
      },
    });
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
      // The authoritative raw-source fingerprint (issue #399): the FULL raw
      // rows, not the mapped projection.
      source_fingerprint: sourceFingerprint('csv-text'),
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
      source_fingerprint: sourceFingerprint('csv-text'),
      file_path: `bank-statements/${jobId}/statement.csv`,
    });
    expect(savedRawSources).toEqual([
      { id: jobId, filename: 'statement.csv', bytes: 'csv-text' },
    ]);
  });

  // ── Issue #399: authoritative raw-source replay identity ──────────

  it('gives two exports that MAP identically but differ in raw bytes DIFFERENT source fingerprints — never one silent replay (issue #399)', async () => {
    jest.spyOn(service, 'runWorkflow').mockResolvedValue(forcedInput);

    // Two INDEPENDENT exports of the same movements: same mapped rows, but
    // the raw sources differ in an unmapped memo value. They are different
    // sources — the fingerprint must say so.
    const exportA =
      'Date,Amount,Currency,Memo\n2026-01-05,-12.50,EUR,export A memo\n';
    const exportB =
      'Date,Amount,Currency,Memo\n2026-01-05,-12.50,EUR,export B memo\n';
    expect(sourceFingerprint(exportA)).not.toBe(sourceFingerprint(exportB));

    const { jobId: jobA } = await service.startImport(
      { text: exportA, buffer: Buffer.from(exportA), filename: 'a.csv' },
      'BANK_EUR',
    );
    const { jobId: jobB } = await service.startImport(
      { text: exportB, buffer: Buffer.from(exportB), filename: 'b.csv' },
      'BANK_EUR',
    );
    for (let i = 0; i < 10; i++) {
      if ((await jobs.get(jobA))?.status !== 'running') break;
      await flush();
    }
    for (let i = 0; i < 10; i++) {
      if ((await jobs.get(jobB))?.status !== 'running') break;
      await flush();
    }

    expect((await jobs.get(jobA))?.status).toBe('done');
    expect((await jobs.get(jobB))?.status).toBe('done');
    // Both imports ran with their OWN fingerprints and archived their OWN
    // byte-exact raw source — neither was collapsed into the other.
    const calls = createStatement.mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(2);
    expect(calls[0].source_fingerprint).toBe(sourceFingerprint(exportA));
    expect(calls[1].source_fingerprint).toBe(sourceFingerprint(exportB));
    expect(calls[0].source_fingerprint).not.toBe(calls[1].source_fingerprint);
    expect(savedRawSources).toEqual([
      { id: jobA, filename: 'a.csv', bytes: exportA },
      { id: jobB, filename: 'b.csv', bytes: exportB },
    ]);
  });

  it('gives an EXACT re-upload (same bytes, renamed) the SAME fingerprint — a true replay (issue #399)', async () => {
    jest.spyOn(service, 'runWorkflow').mockResolvedValue(forcedInput);
    const exportA =
      'Date,Amount,Currency,Memo\n2026-01-05,-12.50,EUR,export A memo\n';
    const { jobId: jobA } = await service.startImport(
      { text: exportA, buffer: Buffer.from(exportA), filename: 'a.csv' },
      'BANK_EUR',
    );
    const { jobId: jobB } = await service.startImport(
      {
        text: exportA,
        buffer: Buffer.from(exportA),
        filename: 'renamed-export.csv',
      },
      'BANK_EUR',
    );
    for (let i = 0; i < 10; i++) {
      if ((await jobs.get(jobA))?.status !== 'running') break;
      await flush();
    }
    for (let i = 0; i < 10; i++) {
      if ((await jobs.get(jobB))?.status !== 'running') break;
      await flush();
    }
    const calls = createStatement.mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(2);
    expect(calls[0].source_fingerprint).toBe(sourceFingerprint(exportA));
    expect(calls[1].source_fingerprint).toBe(sourceFingerprint(exportA));
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
