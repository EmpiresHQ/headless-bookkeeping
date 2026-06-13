import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { AuditLogService } from '../audit-log/audit-log.service';
import { StatutorySubmissionService } from './statutory-submission.service';

describe('StatutorySubmissionService (integration)', () => {
  let db: Kysely<Database>;
  let service: StatutorySubmissionService;

  const SNAPSHOT_ID = 1;

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

    // Migration 011 seeds an 'open' period at id=1. Turn that seeded row into
    // the locked period these tests assert against (id=1), keeping the row id
    // stable rather than relying on AUTOINCREMENT after a delete.
    await db
      .updateTable('reporting_period')
      .set({
        name: '2026-Q1',
        start_date: '2026-01-01',
        end_date: '2026-03-31',
        status: 'locked',
        filed_at: 1000,
        vat_report_snapshot_id: SNAPSHOT_ID,
        created_at: 1000,
      })
      .where('id', '=', 1)
      .execute();
    await db
      .insertInto('vat_report')
      .values({
        reporting_period_id: 1,
        period_name: '2026-Q1',
        start_date: '2026-01-01',
        end_date: '2026-03-31',
        vat_summary: '[]',
        total_input_vat: 0,
        total_output_vat: 0,
        total_payable: 0,
        total_receivable: 0,
        voucher_ids: '[]',
        merkle_root: 'root-abc',
        generated_at: 1000,
      })
      .execute();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        AuditLogService,
        StatutorySubmissionService,
      ],
    }).compile();
    service = module.get(StatutorySubmissionService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('appends a submitted event pinning the snapshot, and folds to submitted', async () => {
    await service.recordEvent(1, {
      event_kind: 'submitted',
      external_ref: 'EMTA-1',
      note: 'uploaded KMD',
      actor: 'op-1',
      report_kind: 'EE_KMD',
      source_snapshot_type: 'vat_report',
      source_snapshot_id: SNAPSHOT_ID,
    });

    const state = await service.getState(1);
    expect(state.status).toBe('submitted');
    expect(state.currentSnapshotId).toBe(SNAPSHOT_ID);
    expect(state.lastExternalRef).toBe('EMTA-1');
    expect(state.history).toHaveLength(1);
    expect(state.history[0].event_kind).toBe('submitted');
    expect(state.history[0].source_snapshot_id).toBe(SNAPSHOT_ID);
    expect(state.history[0].actor).toBe('op-1');
  });

  it('writes an operational audit-log entry as a side effect', async () => {
    await service.recordEvent(1, {
      event_kind: 'submitted',
      external_ref: 'EMTA-1',
      actor: 'op-1',
      report_kind: 'EE_KMD',
      source_snapshot_type: 'vat_report',
      source_snapshot_id: SNAPSHOT_ID,
    });

    const audit = await db
      .selectFrom('audit_log')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(audit.actor).toBe('op-1');
    expect(audit.action).toBe('statutory_submission.event.submitted');
    expect(audit.target_type).toBe('reporting_period');
    expect(audit.target_id).toBe(1);
    expect(JSON.parse(audit.detail ?? '{}')).toMatchObject({
      event_kind: 'submitted',
      external_ref: 'EMTA-1',
      source_snapshot_id: SNAPSHOT_ID,
    });
  });

  it('records a resubmission against the SAME snapshot after a format rejection', async () => {
    const base = {
      actor: 'op-1',
      report_kind: 'EE_KMD',
      source_snapshot_type: 'vat_report',
      source_snapshot_id: SNAPSHOT_ID,
    };
    await service.recordEvent(1, {
      ...base,
      event_kind: 'submitted',
      external_ref: 'EMTA-1',
    });
    await service.recordEvent(1, {
      ...base,
      event_kind: 'rejected',
      note: 'schema error',
    });
    await service.recordEvent(1, {
      ...base,
      event_kind: 'submitted',
      external_ref: 'EMTA-2',
    });

    const state = await service.getState(1);
    expect(state.status).toBe('submitted');
    expect(state.submissionCount).toBe(2);
    expect(state.currentSnapshotId).toBe(SNAPSHOT_ID);
    expect(state.lastExternalRef).toBe('EMTA-2');
    // Both submissions pin the same frozen snapshot.
    const submitted = state.history.filter((h) => h.event_kind === 'submitted');
    expect(submitted.map((h) => h.source_snapshot_id)).toEqual([
      SNAPSHOT_ID,
      SNAPSHOT_ID,
    ]);
  });

  it('NO-UNLOCK INVARIANT: a rejected event leaves the period locked and the snapshot untouched', async () => {
    const snapBefore = await db
      .selectFrom('vat_report')
      .selectAll()
      .where('id', '=', SNAPSHOT_ID)
      .executeTakeFirstOrThrow();

    await service.recordEvent(1, {
      event_kind: 'rejected',
      note: 'rejected by e-MTA',
      actor: 'op-1',
      report_kind: 'EE_KMD',
      source_snapshot_type: 'vat_report',
      source_snapshot_id: SNAPSHOT_ID,
    });

    const period = await db
      .selectFrom('reporting_period')
      .selectAll()
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    expect(period.status).toBe('locked');
    expect(period.vat_report_snapshot_id).toBe(SNAPSHOT_ID);

    const snapAfter = await db
      .selectFrom('vat_report')
      .selectAll()
      .where('id', '=', SNAPSHOT_ID)
      .executeTakeFirstOrThrow();
    expect(snapAfter).toEqual(snapBefore);

    const state = await service.getState(1);
    expect(state.status).toBe('rejected');
  });
});
