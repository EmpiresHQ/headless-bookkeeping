import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { ReportingPeriodsService } from './reporting-periods.service';
import { VatReportService } from '../vat-report/vat-report.service';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { OrganizationService } from '../organization/organization.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { StatutorySubmissionService } from '../statutory-submission/statutory-submission.service';

/**
 * Integration test for ReportingPeriodsService against a real in-memory
 * SQLite database seeded by the real migration (011_create_reporting_period).
 *
 * Proves:
 *  (a) seeded 2024-Q1 exists
 *  (b) getCurrent returns the latest open period by start_date
 *  (c) locked periods are ignored by getCurrent
 */
describe('ReportingPeriodsService (integration)', () => {
  let db: Kysely<Database>;
  let service: ReportingPeriodsService;

  beforeEach(async () => {
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });

    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error, results } = await migrator.migrateToLatest();
    if (error)
      throw error instanceof Error ? error : new Error('Migration failed');

    // Verify the reporting_period migration ran
    const ranMigration = results?.find(
      (r) => r.migrationName === '011_create_reporting_period',
    );
    if (!ranMigration || ranMigration.status !== 'Success') {
      throw new Error(
        `Migration 011_create_reporting_period did not succeed: ${JSON.stringify(results)}`,
      );
    }

    // Construct the service directly with the DB instance — the G2 harness
    // pattern from currency.resolution.spec.ts uses Test.createTestingModule
    // with manual token override, but here we inject the Kysely instance
    // directly via the constructor to avoid DI resolution issues with the
    // nestjs-kysely token in a minimal module.
    const organizationService = new OrganizationService(db);
    const pluginLoader = new PluginLoader(
      new NullCountryPlugin(),
      new EstoniaCountryPlugin(),
    );
    const vatReportService = new VatReportService(
      db,
      new LedgerBalanceService(db),
      pluginLoader,
      organizationService,
    );
    service = new ReportingPeriodsService(
      db,
      vatReportService,
      organizationService,
      pluginLoader,
      new StatutorySubmissionService(db, new AuditLogService(db)),
    );
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('(a) seeded 2024-Q1 exists with open status', async () => {
    const all = await service.list();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('2024-Q1');
    expect(all[0].start_date).toBe('2024-01-01');
    expect(all[0].end_date).toBe('2024-03-31');
    expect(all[0].status).toBe('open');
    expect(all[0].filed_at).toBeNull();
    expect(all[0].vat_report_snapshot_id).toBeNull();
  });

  it('(b) getCurrent returns the latest open period by start_date', async () => {
    // Seed a second open period with a later start_date
    await service.create({
      name: '2024-Q2',
      start_date: '2024-04-01',
      end_date: '2024-06-30',
    });

    const current = await service.getCurrent();
    expect(current.name).toBe('2024-Q2');
    expect(current.status).toBe('open');
  });

  it('(c) locked periods are ignored by getCurrent', async () => {
    // Lock the seeded 2024-Q1 period by updating its status directly
    await db
      .updateTable('reporting_period')
      .set({ status: 'locked' })
      .where('name', '=', '2024-Q1')
      .execute();

    // No open periods remain → getCurrent should throw
    await expect(service.getCurrent()).rejects.toThrow(
      'No open reporting period found',
    );
  });

  it('(d) rejects a period overlapping an existing one (D3)', async () => {
    // 2024-03-01..2024-05-31 overlaps the seeded 2024-Q1 (..2024-03-31).
    await expect(
      service.create({
        name: 'OVERLAP',
        start_date: '2024-03-01',
        end_date: '2024-05-31',
      }),
    ).rejects.toThrow(/overlap/i);

    // The overlapping period must NOT have been persisted.
    const all = await service.list();
    expect(all.map((p) => p.name)).not.toContain('OVERLAP');
  });

  it('(d2) allows a contiguous, non-overlapping period', async () => {
    const created = await service.create({
      name: '2024-Q2',
      start_date: '2024-04-01',
      end_date: '2024-06-30',
    });
    expect(created.name).toBe('2024-Q2');
  });

  it('(e) deleteEmptyPeriod removes an empty open period', async () => {
    const p = await service.create({
      name: '2024-Q2',
      start_date: '2024-04-01',
      end_date: '2024-06-30',
    });
    const deleted = await service.deleteEmptyPeriod(p.id);
    expect(deleted.id).toBe(p.id);
    const names = (await service.list()).map((x) => x.name);
    expect(names).not.toContain('2024-Q2');
  });

  it('(f) refuses to delete a period that has vouchers', async () => {
    const p = await service.create({
      name: '2026',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
    });
    await db
      .insertInto('voucher')
      .values({ voucher_number: 'V-IN-2026', tax_point_date: '2026-06-15' })
      .execute();
    await expect(service.deleteEmptyPeriod(p.id)).rejects.toThrow(/vouchers/i);
  });

  it('(g) refuses to delete a locked period', async () => {
    await db
      .updateTable('reporting_period')
      .set({ status: 'locked' })
      .where('name', '=', '2024-Q1')
      .execute();
    const q1 = (await service.list()).find((x) => x.name === '2024-Q1')!;
    await expect(service.deleteEmptyPeriod(q1.id)).rejects.toThrow(/locked/i);
  });

  it('(h) throws NotFound for a missing id', async () => {
    await expect(service.deleteEmptyPeriod(9999)).rejects.toThrow(
      'Reporting period 9999 not found',
    );
  });
});
