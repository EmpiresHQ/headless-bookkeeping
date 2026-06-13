import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { NotFoundException } from '@nestjs/common';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { AuditLogService } from '../audit-log/audit-log.service';
import { StatutorySubmissionService } from './statutory-submission.service';
import { StatutorySubmissionController } from './statutory-submission.controller';

describe('StatutorySubmissionController (integration)', () => {
  let db: Kysely<Database>;
  let controller: StatutorySubmissionController;

  const SNAPSHOT_ID = 1;

  beforeEach(async () => {
    const rawDb = new SqliteDb(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = new Kysely<Database>({ dialect: new SqliteDialect({ database: rawDb }) });

    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error instanceof Error ? error : new Error('Migration failed');

    // Migration 011 seeds an 'open' period at id=1. Update it into the locked
    // period the controller tests assert against (keeps row id stable).
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
      controllers: [StatutorySubmissionController],
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        AuditLogService,
        StatutorySubmissionService,
      ],
    }).compile();
    controller = module.get(StatutorySubmissionController);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('POST records an event pinned to the period snapshot and returns it', async () => {
    const ev = await controller.recordEvent(1, {
      event_kind: 'submitted',
      external_ref: 'EMTA-1',
    });
    expect(ev.event_kind).toBe('submitted');
    expect(ev.source_snapshot_type).toBe('vat_report');
    expect(ev.source_snapshot_id).toBe(SNAPSHOT_ID);
    expect(ev.external_ref).toBe('EMTA-1');
    expect(ev.actor).toBe('operator');
  });

  it('GET returns the folded state plus full history', async () => {
    await controller.recordEvent(1, { event_kind: 'submitted', external_ref: 'EMTA-1' });
    await controller.recordEvent(1, { event_kind: 'accepted', external_ref: 'EMTA-1' });

    const state = await controller.getState(1);
    expect(state.status).toBe('accepted');
    expect(state.currentSnapshotId).toBe(SNAPSHOT_ID);
    expect(state.history).toHaveLength(2);
    expect(state.history.map((h) => h.event_kind)).toEqual([
      'submitted',
      'accepted',
    ]);
  });

  it('POST 404s when the period has no frozen snapshot', async () => {
    await db
      .insertInto('reporting_period')
      .values({
        name: '2026-Q2',
        start_date: '2026-04-01',
        end_date: '2026-06-30',
        status: 'open',
        filed_at: null,
        vat_report_snapshot_id: null,
        created_at: 1000,
      })
      .execute();
    await expect(
      controller.recordEvent(2, { event_kind: 'submitted' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
