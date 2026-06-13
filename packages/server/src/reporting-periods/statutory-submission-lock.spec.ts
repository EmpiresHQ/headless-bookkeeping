import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { ReportingPeriodsService } from './reporting-periods.service';
import { VatReportService } from '../vat-report/vat-report.service';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { OrganizationService } from '../organization/organization.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { AuditLogService } from '../audit-log/audit-log.service';
import { StatutorySubmissionService } from '../statutory-submission/statutory-submission.service';

describe('ReportingPeriod lock → prepared event (integration)', () => {
  let db: Kysely<Database>;
  let periods: ReportingPeriodsService;
  let submission: StatutorySubmissionService;

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

    // Migration 001 seeds a singleton organization at id=1 (CHECK id = 1), and
    // migration 011 seeds a `2024-Q1` open reporting_period at id=1. We turn
    // both seeded rows into our EE fixture via UPDATE (a second INSERT into
    // either would violate the singleton / collide on PK and skew ids). The
    // period stays the earliest open one so the filing-order rule is satisfied
    // and `lock(1)` targets exactly this row.
    await db
      .updateTable('organization')
      .where('id', '=', 1)
      .set({ country: 'EE', base_currency: null, vat_registered: 1 })
      .execute();
    await db
      .updateTable('reporting_period')
      .where('id', '=', 1)
      .set({
        name: '2026-Q1',
        start_date: '2026-01-01',
        end_date: '2026-03-31',
        status: 'open',
        filed_at: null,
        vat_report_snapshot_id: null,
      })
      .execute();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        ReportingPeriodsService,
        VatReportService,
        LedgerBalanceService,
        OrganizationService,
        PluginLoader,
        NullCountryPlugin,
        EstoniaCountryPlugin,
        AuditLogService,
        StatutorySubmissionService,
      ],
    }).compile();

    periods = module.get(ReportingPeriodsService);
    submission = module.get(StatutorySubmissionService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('locking writes exactly one prepared event pinned to the frozen VAT snapshot, and stamps filed_at', async () => {
    const locked = await periods.lock(1);
    expect(locked.status).toBe('locked');
    expect(locked.filed_at).toBeGreaterThan(0);
    expect(locked.vat_report_snapshot_id).not.toBeNull();

    const state = await submission.getState(1);
    expect(state.status).toBe('prepared');
    expect(state.history).toHaveLength(1);
    const ev = state.history[0];
    expect(ev.event_kind).toBe('prepared');
    expect(ev.source_snapshot_type).toBe('vat_report');
    expect(ev.source_snapshot_id).toBe(locked.vat_report_snapshot_id);
    expect(ev.report_kind).toBe('EE_KMD');
  });

  it('re-locking is idempotent — no duplicate prepared event', async () => {
    await periods.lock(1);
    await periods.lock(1);
    const state = await submission.getState(1);
    expect(state.history).toHaveLength(1);
  });
});
