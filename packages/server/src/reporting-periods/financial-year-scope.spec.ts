import { unusedFxRateService } from '../../test/fx-fixtures';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { ReportingPeriodsService } from './reporting-periods.service';
import { PeriodLockService } from './period-lock.service';
import { StatutoryReportService } from '../statutory-report/statutory-report.service';
import { AuditFindingsService } from '../audit-findings/audit-findings.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { VatReportService } from '../vat-report/vat-report.service';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { OrganizationService } from '../organization/organization.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { StatutorySubmissionService } from '../statutory-submission/statutory-submission.service';

/**
 * Issue #207 — the two timelines, against a real migrated SQLite database and
 * the real services.
 *
 * The scenario throughout is the ordinary one that used to be impossible: a
 * normal monthly VAT calendar for 2026 and the financial year 2026 that spans
 * it.
 */
describe('Reporting periods: VAT calendar and financial years (integration)', () => {
  let db: Kysely<Database>;
  let service: ReportingPeriodsService;
  let periodLock: PeriodLockService;

  const months = (
    year: number,
  ): Array<{ name: string; start: string; end: string }> =>
    Array.from({ length: 12 }, (_, i) => {
      const m = String(i + 1).padStart(2, '0');
      const last = new Date(Date.UTC(year, i + 1, 0))
        .toISOString()
        .slice(8, 10);
      return {
        name: `${year}-${m}`,
        start: `${year}-${m}-01`,
        end: `${year}-${m}-${last}`,
      };
    });

  async function createTwelveMonths(year: number): Promise<void> {
    for (const m of months(year)) {
      await service.create({
        name: m.name,
        start_date: m.start,
        end_date: m.end,
      });
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
    // Migration 011 seeds a stray 2024-Q1; the fixtures below are self-contained.
    await db.deleteFrom('reporting_period').execute();

    const organizationService = new OrganizationService(db);
    const pluginLoader = new PluginLoader(
      new NullCountryPlugin(),
      new EstoniaCountryPlugin(unusedFxRateService()),
    );
    const vatReportService = new VatReportService(
      db,
      new LedgerBalanceService(db),
      pluginLoader,
      organizationService,
    );
    const submissions = new StatutorySubmissionService(
      db,
      new AuditLogService(db),
    );
    const auditFindings = new AuditFindingsService(db);
    service = new ReportingPeriodsService(
      db,
      vatReportService,
      organizationService,
      pluginLoader,
      submissions,
      new StatutoryReportService(
        db,
        new LedgerBalanceService(db),
        vatReportService,
        new OrgContextResolver(organizationService, pluginLoader),
        auditFindings,
        submissions,
        pluginLoader,
      ),
      auditFindings,
    );
    periodLock = new PeriodLockService(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('accepts a financial year spanning twelve monthly VAT periods', async () => {
    await createTwelveMonths(2026);

    const fy = await service.create({
      name: 'FY2026',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      kind: 'annual',
    });

    expect(fy.kind).toBe('annual');
    expect(fy.status).toBe('open');
    // Both timelines are intact: twelve VAT periods, one financial year.
    expect(await service.list('vat')).toHaveLength(12);
    expect((await service.list('annual')).map((p) => p.name)).toEqual([
      'FY2026',
    ]);
    expect(await service.list('all')).toHaveLength(13);
    // The default listing is the VAT calendar — what every pre-#207 caller means.
    expect(await service.list()).toHaveLength(12);
  });

  it('still rejects an overlap WITHIN each timeline', async () => {
    await createTwelveMonths(2026);
    await service.create({
      name: 'FY2026',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      kind: 'annual',
    });

    // A second March overlaps the VAT calendar.
    await expect(
      service.create({
        name: '2026-03-dup',
        start_date: '2026-03-15',
        end_date: '2026-04-15',
      }),
    ).rejects.toThrow(/overlaps existing period/i);

    // A second financial year overlaps the annual calendar.
    await expect(
      service.create({
        name: 'FY2026-dup',
        start_date: '2026-07-01',
        end_date: '2027-06-30',
        kind: 'annual',
      }),
    ).rejects.toThrow(/overlaps existing financial year/i);

    expect(await service.list('vat')).toHaveLength(12);
    expect(await service.list('annual')).toHaveLength(1);
  });

  it('supports a non-calendar fiscal year alongside the monthly calendar', async () => {
    await createTwelveMonths(2026);
    const fy = await service.create({
      name: 'FY2026/27',
      start_date: '2026-07-01',
      end_date: '2027-06-30',
      kind: 'annual',
    });
    expect(fy.start_date).toBe('2026-07-01');
    expect(fy.end_date).toBe('2027-06-30');
  });

  it('refuses to FILE a financial year — a year has no VAT declaration', async () => {
    const fy = await service.create({
      name: 'FY2026',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      kind: 'annual',
    });

    await expect(service.lock(fy.id)).rejects.toThrow(/financial year/i);

    // Nothing was frozen and nothing was flipped: no KMD was manufactured.
    expect(
      await db.selectFrom('vat_report').selectAll().execute(),
    ).toHaveLength(0);
    expect(
      await db.selectFrom('statutory_filing_snapshot').selectAll().execute(),
    ).toHaveLength(0);
    expect(
      await db.selectFrom('statutory_submission_event').selectAll().execute(),
    ).toHaveLength(0);
    expect((await service.getById(fy.id)).status).toBe('open');
  });

  it('refuses to reconcile a financial year, and refuses to CLOSE a VAT period', async () => {
    const fy = await service.create({
      name: 'FY2026',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      kind: 'annual',
    });
    const month = await service.create({
      name: '2026-01',
      start_date: '2026-01-01',
      end_date: '2026-01-31',
    });

    await expect(service.reconcileFilingSnapshot(fy.id)).rejects.toThrow(
      /financial year/i,
    );
    await expect(service.closeFinancialYear(month.id)).rejects.toThrow(
      /VAT period, not a financial year/i,
    );
  });

  it('closes a financial year without writing any VAT artifact, idempotently and in order', async () => {
    const fy2025 = await service.create({
      name: 'FY2025',
      start_date: '2025-01-01',
      end_date: '2025-12-31',
      kind: 'annual',
    });
    const fy2026 = await service.create({
      name: 'FY2026',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      kind: 'annual',
    });

    // Order across the annual timeline: FY2025 must be closed first.
    await expect(service.closeFinancialYear(fy2026.id)).rejects.toThrow(
      /earlier financial year FY2025 is still open/i,
    );

    const closed = await service.closeFinancialYear(fy2025.id);
    expect(closed.status).toBe('locked');
    expect(closed.filed_at).not.toBeNull();
    expect(closed.vat_report_snapshot_id).toBeNull();
    expect(
      await db.selectFrom('vat_report').selectAll().execute(),
    ).toHaveLength(0);
    expect(
      await db.selectFrom('statutory_submission_event').selectAll().execute(),
    ).toHaveLength(0);

    // Idempotent: closing again changes nothing.
    const again = await service.closeFinancialYear(fy2025.id);
    expect(again.filed_at).toBe(closed.filed_at);
  });

  it('files a month while the financial year around it is still open', async () => {
    await service.create({
      name: 'FY2026',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      kind: 'annual',
    });
    const jan = await service.create({
      name: '2026-01',
      start_date: '2026-01-01',
      end_date: '2026-01-31',
    });

    // The open financial year spanning January must not count as an "earlier
    // open period" blocking the monthly filing.
    const filed = await service.lock(jan.id);
    expect(filed.status).toBe('locked');
    expect(filed.vat_report_snapshot_id).not.toBeNull();
  });

  it('seals every date in a closed financial year, even where the month is open', async () => {
    const fy = await service.create({
      name: 'FY2026',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      kind: 'annual',
    });
    const nov = await service.create({
      name: '2026-11',
      start_date: '2026-11-01',
      end_date: '2026-11-30',
    });
    await service.closeFinancialYear(fy.id);

    expect((await service.getById(nov.id)).status).toBe('open');
    const locked = await periodLock.findLockedPeriod('2026-11-15');
    expect(locked?.name).toBe('FY2026');
    await expect(periodLock.assertPeriodOpen('2026-11-15')).rejects.toThrow(
      /closed financial year FY2026/i,
    );
  });

  it('never redirects a correction into a month inside a closed financial year', async () => {
    const fy = await service.create({
      name: 'FY2026',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      kind: 'annual',
    });
    await service.create({
      name: '2026-12',
      start_date: '2026-12-01',
      end_date: '2026-12-31',
    });
    const jan27 = await service.create({
      name: '2027-01',
      start_date: '2027-01-01',
      end_date: '2027-01-31',
    });
    await service.closeFinancialYear(fy.id);

    // 2026-12 is the latest open VAT period by start_date, but it is inside the
    // closed year — redirecting there would only hit the next wall.
    const target = await periodLock.getCurrentOpenPeriod();
    expect(target?.id).toBe(jan27.id);
  });

  it('getCurrent answers with the VAT calendar, never a financial year', async () => {
    await service.create({
      name: 'FY2026',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      kind: 'annual',
    });
    await expect(service.getCurrent()).rejects.toThrow(
      'No open reporting period found',
    );

    const jan = await service.create({
      name: '2026-01',
      start_date: '2026-01-01',
      end_date: '2026-01-31',
    });
    expect((await service.getCurrent()).id).toBe(jan.id);
  });

  it('lets an operator delete a mistaken financial year, but not one that has closed anything', async () => {
    const fy = await service.create({
      name: 'FY2026',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      kind: 'annual',
    });
    // Ordinary trading inside the year belongs to the months, not to the year.
    await db
      .insertInto('voucher')
      .values({
        voucher_number: 'V-2026-000001',
        tax_point_date: '2026-06-15',
        posted_at: 1,
      })
      .execute();
    const deleted = await service.deleteEmptyPeriod(fy.id);
    expect(deleted.id).toBe(fy.id);

    // A year whose close posted a year-end adjustment is NOT empty.
    const fy2 = await service.create({
      name: 'FY2027',
      start_date: '2027-01-01',
      end_date: '2027-12-31',
      kind: 'annual',
    });
    await db
      .insertInto('voucher')
      .values({
        voucher_number: 'V-2027-000001',
        tax_point_date: '2027-12-31',
        posted_at: 1,
        annual_close_period_id: fy2.id,
      })
      .execute();
    await expect(service.deleteEmptyPeriod(fy2.id)).rejects.toThrow(
      /year-end adjustments/i,
    );
  });
});
