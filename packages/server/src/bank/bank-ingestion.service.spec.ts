import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { BankImportJobRepository } from './bank-import-job.repository';
import { BankMappingProfileRepository } from './bank-mapping-profile.repository';
import { BankIngestionService } from './bank-ingestion.service';
import type { CreateStatementInput } from './bank-statement.types';
import type { MappingRuleset } from './bank-mapping.types';
import {
  applyRules,
  headerColumns,
  headerSignature,
  sourceFingerprint,
} from './apply-rules';
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
  let profiles: BankMappingProfileRepository;
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

  // A real, valid mapping for the legacy tests' synthetic CSV texts.
  function workflowResultFor(csvText: string) {
    const headers = headerColumns(csvText);
    const first = headers[0] ?? 'csv-text';
    const amountColumn = headers[1] ?? first;
    const ruleset: MappingRuleset = {
      account_code: 'BANK_EUR',
      date_column: first,
      date_format: 'YYYY-MM-DD',
      amount: { mode: 'signed', column: amountColumn },
      currency_column: null,
      default_currency: 'EUR',
      description_column: null,
      counterparty_iban_column: null,
      counterparty_descriptor_column: null,
      reference_column: null,
    };
    return { ruleset, input: forcedInput };
  }

  function mockWorkflow() {
    return jest
      .spyOn(service, 'runWorkflow')
      .mockImplementation((csvText) =>
        Promise.resolve(workflowResultFor(csvText)),
      );
  }

  async function settle(jobId: number): Promise<void> {
    for (let i = 0; i < 20; i++) {
      const job = await jobs.get(jobId);
      if (job?.status !== 'running') return;
      await flush();
    }
  }

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
    profiles = new BankMappingProfileRepository(db);

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

    service = new BankIngestionService(
      mastra,
      statements,
      jobs,
      storage,
      profiles,
    );
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('startImport returns a jobId and synchronously records a running job', async () => {
    mockWorkflow();

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
    mockWorkflow();

    const { jobId } = await service.startImport(
      {
        text: 'csv-text',
        buffer: Buffer.from('csv-text'),
        filename: 'statement.csv',
      },
      'BANK_EUR',
    );

    await settle(jobId);

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
    mockWorkflow();

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
    await settle(jobId);
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
    mockWorkflow();

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
    await settle(jobA);
    await settle(jobB);

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
    mockWorkflow();
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
    await settle(jobA);
    await settle(jobB);
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

    await settle(jobId);

    const job = await service.getImportStatus(jobId);
    expect(job?.status).toBe('failed');
    expect(job?.error).toBe('boom');
    expect(createStatement).not.toHaveBeenCalled();
  });

  // ── Bank mapping profile: reuse a successful mapping, never cache a failure ──

  const mappingCsv =
    'Date,Amount,D/C,Currency,Explanation\n' +
    '2026-10-01,27.59,D,EUR,Invoice 1000\n' +
    '2026-10-02,6157.00,C,EUR,Payment received\n';

  const mappingRuleset: MappingRuleset = {
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

  async function importCsv(csvText: string): Promise<number> {
    const { jobId } = await service.startImport(
      { text: csvText, buffer: Buffer.from(csvText), filename: 'oct.csv' },
      'BANK_EUR',
    );
    await settle(jobId);
    return jobId;
  }

  it('first import (no profile) infers with the LLM and saves the profile after success', async () => {
    const runWorkflow = jest
      .spyOn(service, 'runWorkflow')
      .mockImplementation((csvText) =>
        Promise.resolve({
          ruleset: mappingRuleset,
          input: applyRules(mappingRuleset, csvText),
        }),
      );

    const jobId = await importCsv(mappingCsv);

    expect(runWorkflow).toHaveBeenCalledTimes(1);
    expect((await jobs.get(jobId))?.status).toBe('done');
    const stored = await profiles.findProfile(
      'BANK_EUR',
      headerSignature(mappingCsv),
    );
    expect(stored?.ruleset).toEqual(mappingRuleset);
    expect(stored?.source_job_id).toBe(jobId);
    expect(stored?.header_json).toBe(
      JSON.stringify(['Date', 'Amount', 'D/C', 'Currency', 'Explanation']),
    );
    expect((await jobs.get(jobId))?.summary?.mappingSource).toBe('inferred');
  });

  it('a repeat import with the same header reuses the profile — the LLM is NOT called and the profile is touched', async () => {
    const runWorkflow = jest
      .spyOn(service, 'runWorkflow')
      .mockImplementation((csvText) =>
        Promise.resolve({
          ruleset: mappingRuleset,
          input: applyRules(mappingRuleset, csvText),
        }),
      );
    const firstJob = await importCsv(mappingCsv);
    expect(runWorkflow).toHaveBeenCalledTimes(1);
    const stored = await profiles.findProfile(
      'BANK_EUR',
      headerSignature(mappingCsv),
    );
    expect(stored).not.toBeNull();
    const touch = jest.spyOn(profiles, 'touch');

    runWorkflow.mockClear();
    // Same export format, different statement rows.
    const nextMonth =
      'Date,Amount,D/C,Currency,Explanation\n' +
      '2026-11-01,10.00,D,EUR,November invoice\n';
    const secondJob = await importCsv(nextMonth);

    expect(runWorkflow).not.toHaveBeenCalled();
    expect(touch).toHaveBeenCalledWith(stored!.id);
    expect((await jobs.get(secondJob))?.status).toBe('done');
    expect((await jobs.get(secondJob))?.summary?.mappingSource).toBe('profile');
    // The first import's profile is still the only one for this format.
    expect(await profiles.list('BANK_EUR')).toHaveLength(1);
    expect((await jobs.get(firstJob))?.status).toBe('done');
  });

  it('does NOT save a profile when the inferred ruleset fails validation', async () => {
    // The production incident's shape: fx_rate pointed at the D/C column.
    const badRuleset: MappingRuleset = {
      ...mappingRuleset,
      fx_rate: { column: 'D/C' },
    };
    const runWorkflow = jest.spyOn(service, 'runWorkflow').mockResolvedValue({
      ruleset: badRuleset,
      input: forcedInput,
    });

    const jobId = await importCsv(mappingCsv);

    expect(runWorkflow).toHaveBeenCalledTimes(1);
    const job = await jobs.get(jobId);
    expect(job?.status).toBe('failed');
    expect(job?.error).toMatch(/bank_mapping ruleset rejected: fx_rate/);
    expect(createStatement).not.toHaveBeenCalled();
    expect(await profiles.list('BANK_EUR')).toHaveLength(0);
  });

  it('does NOT save a profile when createStatement fails', async () => {
    jest.spyOn(service, 'runWorkflow').mockImplementation((csvText) =>
      Promise.resolve({
        ruleset: mappingRuleset,
        input: applyRules(mappingRuleset, csvText),
      }),
    );
    createStatement.mockRejectedValueOnce(new Error('statement insert failed'));

    const jobId = await importCsv(mappingCsv);

    const job = await jobs.get(jobId);
    expect(job?.status).toBe('failed');
    expect(job?.error).toBe('statement insert failed');
    expect(await profiles.list('BANK_EUR')).toHaveLength(0);
  });

  it('does not fall back to the LLM when a stored profile fails to apply — the error names the profile', async () => {
    // A stored profile that no longer fits its own format (reset needed).
    await profiles.save({
      accountCode: 'BANK_EUR',
      headerHash: headerSignature(mappingCsv),
      headerColumns: ['Date', 'Amount', 'D/C', 'Currency', 'Explanation'],
      ruleset: { ...mappingRuleset, date_column: 'MissingDate' },
      sourceJobId: 1,
    });
    const runWorkflow = jest.spyOn(service, 'runWorkflow');

    const jobId = await importCsv(mappingCsv);

    expect(runWorkflow).not.toHaveBeenCalled();
    const job = await jobs.get(jobId);
    expect(job?.status).toBe('failed');
    expect(job?.error).toMatch(/^stored bank mapping profile failed: /);
    expect(createStatement).not.toHaveBeenCalled();
  });

  it('a profile save failure does not fail an otherwise successful import', async () => {
    jest.spyOn(service, 'runWorkflow').mockImplementation((csvText) =>
      Promise.resolve({
        ruleset: mappingRuleset,
        input: applyRules(mappingRuleset, csvText),
      }),
    );
    jest
      .spyOn(profiles, 'save')
      .mockRejectedValue(new Error('profile store unavailable'));

    const jobId = await importCsv(mappingCsv);

    const job = await jobs.get(jobId);
    expect(job?.status).toBe('done');
    expect(job?.error).toBeNull();
  });
});
