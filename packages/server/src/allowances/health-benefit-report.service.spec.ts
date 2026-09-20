import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { HealthBenefitReportService } from './health-benefit-report.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { OrganizationService } from '../organization/organization.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { seedEntity } from '../../test/helpers/seed-entity';
import { seedAllowance } from '../../test/helpers/seed-allowance';

/**
 * The declaration figures behind posted health benefits (issue #212): TSD annex
 * 4 code 4120 monthly, INF 14 part III annually — and, as importantly, what the
 * report refuses to certify.
 */
describe('HealthBenefitReportService (issue #212)', () => {
  let db: Kysely<Database>;
  let service: HealthBenefitReportService;

  beforeEach(async () => {
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error)
      throw error instanceof Error ? error : new Error('Migration failed');

    await db
      .updateTable('organization')
      .set({ country: 'EE', vat_registered: 1 })
      .where('id', '=', 1)
      .execute();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        NullCountryPlugin,
        {
          provide: EstoniaCountryPlugin,
          useFactory: () =>
            new EstoniaCountryPlugin(
              {} as ConstructorParameters<typeof EstoniaCountryPlugin>[0],
            ),
        },
        PluginLoader,
        OrganizationService,
        OrgContextResolver,
        HealthBenefitReportService,
      ],
    }).compile();

    service = module.get(HealthBenefitReportService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('reports the taxable excess monthly under code 4120 and the exempt total annually', async () => {
    const claimant = await seedEntity(db, { role: 'employee' });
    const seeded = await seedAllowance(db, {
      claimantId: claimant.id,
      type: 'health',
      taxFreeAmount: 40000,
      taxableAmount: 60000,
      periodStart: '2026-09-01',
      status: 'posted',
      fringeIncomeTax: 16923,
      fringeSocialTax: 25385,
      health: {
        category: 'sports_facility_fee',
        claimantRelation: 'employee',
        supportingDocumentRef: 'INV-1',
        offeredToAllEmployees: true,
      },
    });
    await db
      .updateTable('allowance')
      .set({
        exemption_basis: 'statutory_health_exemption',
        limit_window: '2026',
      })
      .where('id', '=', seeded.id)
      .execute();

    const report = await service.report(2026);

    expect(report.tsdAnnex4.benefitCode).toBe('4120');
    expect(report.tsdAnnex4.months).toHaveLength(1);
    const month = report.tsdAnnex4.months[0];
    expect(month.month).toBe('2026-09');
    expect(month.benefitValue).toBe(60000);
    expect(month.ledgerTax).toEqual({ incomeTax: 16923, socialTax: 25385 });
    expect(month.declarationTax).toEqual({
      incomeTax: 16923,
      socialTax: 25385,
    });
    expect(month.dueDate).toBe('2026-10-10');
    // The audit trail: which claim, and which voucher, each figure came from.
    expect(month.claims).toEqual([
      expect.objectContaining({
        allowanceId: seeded.id,
        claimantId: claimant.id,
      }),
    ]);

    expect(report.inf14PartIii).toMatchObject({
      exemptTotal: 40000,
      employees: 1,
      dueDate: '2027-02-01',
    });
    expect(report.readyToFile).toBe(true);
  });

  it('names the rounding gap between per-claim tax and the monthly declaration', async () => {
    // Two 2.00 benefits in one month. Per claim: income round(200*22/78) = 56,
    // social round(256*0.33) = 84 — 112 and 168 summed. On the month's 4.00:
    // income round(400*22/78) = 113, social round(513*0.33) = 169. One cent
    // apart on each, from rounding once versus twice.
    const claimant = await seedEntity(db, { role: 'employee' });
    for (const ref of ['A', 'B']) {
      const row = await seedAllowance(db, {
        claimantId: claimant.id,
        type: 'health',
        taxFreeAmount: 0,
        taxableAmount: 200,
        periodStart: '2026-04-10',
        status: 'posted',
        fringeIncomeTax: 56,
        fringeSocialTax: 84,
        health: {
          category: 'gym_smoothies',
          claimantRelation: 'employee',
          supportingDocumentRef: ref,
          offeredToAllEmployees: true,
        },
      });
      await db
        .updateTable('allowance')
        .set({ exemption_basis: 'ineligible', limit_window: '2026' })
        .where('id', '=', row.id)
        .execute();
    }

    const report = await service.report(2026);
    const month = report.tsdAnnex4.months[0];

    expect(month.benefitValue).toBe(400);
    expect(month.ledgerTax).toEqual({ incomeTax: 112, socialTax: 168 });
    expect(month.declarationTax).toEqual({ incomeTax: 113, socialTax: 169 });
    expect(month.roundingAdjustment).toEqual({ incomeTax: 1, socialTax: 1 });
    // A month whose two arithmetics disagree is NOT presented as filed-ready.
    expect(report.readyToFile).toBe(false);
    expect(report.filingNotes.join(' ')).toContain('2026-04');
  });

  it('surfaces claims posted before the exemption was accounted for, without touching them', async () => {
    const claimant = await seedEntity(db, { role: 'employee' });
    // The bug's own output: 1000.00 booked entirely tax-free, no basis recorded.
    const legacy = await seedAllowance(db, {
      claimantId: claimant.id,
      type: 'health',
      taxFreeAmount: 100000,
      taxableAmount: 0,
      periodStart: '2026-02-01',
      status: 'posted',
    });

    const report = await service.report(2026);

    expect(report.unresolvedHistoricalClaims).toEqual([
      expect.objectContaining({ allowanceId: legacy.id, exemptAmount: 100000 }),
    ]);
    expect(report.readyToFile).toBe(false);
    expect(report.filingNotes.join(' ')).toContain(
      'predate the exemption accounting',
    );

    // The row itself is untouched — a posted claim is not rewritten to make a
    // report look clean.
    const after = await db
      .selectFrom('allowance')
      .selectAll()
      .where('id', '=', legacy.id)
      .executeTakeFirstOrThrow();
    expect(after.tax_free_amount).toBe(100000);
    expect(after.exemption_basis).toBeNull();
  });

  it('flags a claim whose voucher was reversed, keeping it in the totals', async () => {
    const claimant = await seedEntity(db, { role: 'employee' });
    const voucher = await db
      .insertInto('voucher')
      .values({
        voucher_number: 'V-1',
        tax_point_date: '2026-05-01',
        posted_at: 1,
        previous_hash: null,
        reverses_id: null,
        corrects_object_type: null,
        corrects_object_id: null,
        reason: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const row = await seedAllowance(db, {
      claimantId: claimant.id,
      type: 'health',
      taxFreeAmount: 40000,
      taxableAmount: 0,
      periodStart: '2026-05-01',
      status: 'posted',
    });
    await db
      .updateTable('allowance')
      .set({
        voucher_id: voucher.id,
        exemption_basis: 'statutory_health_exemption',
        limit_window: '2026',
      })
      .where('id', '=', row.id)
      .execute();
    await db
      .insertInto('voucher')
      .values({
        voucher_number: 'V-2',
        tax_point_date: '2026-06-01',
        posted_at: 1,
        previous_hash: null,
        reverses_id: voucher.id,
        corrects_object_type: null,
        corrects_object_id: null,
        reason: 'partial reversal',
      })
      .execute();

    const report = await service.report(2026);

    expect(report.unresolvedHistoricalClaims[0]).toMatchObject({
      allowanceId: row.id,
      voucherId: voucher.id,
    });
    expect(report.unresolvedHistoricalClaims[0].reason).toContain('reversed');
    // Still counted: a reversal chain does not prove the benefit was undone,
    // so the report neither nets it off nor drops it — it raises it.
    expect(report.inf14PartIii.exemptTotal).toBe(40000);
    expect(report.readyToFile).toBe(false);
  });

  it('flags a taxable benefit carrying no employer tax', async () => {
    const claimant = await seedEntity(db, { role: 'employee' });
    const row = await seedAllowance(db, {
      claimantId: claimant.id,
      type: 'health',
      taxFreeAmount: 0,
      taxableAmount: 5000,
      periodStart: '2026-06-01',
      status: 'posted',
    });
    await db
      .updateTable('allowance')
      .set({ exemption_basis: 'ineligible', limit_window: '2026' })
      .where('id', '=', row.id)
      .execute();

    const report = await service.report(2026);
    expect(report.unresolvedHistoricalClaims[0].reason).toContain(
      'no employer fringe-benefit tax',
    );
    expect(report.readyToFile).toBe(false);
  });

  it('refuses to render Estonian forms for a jurisdiction that has no such exemption', async () => {
    await db
      .updateTable('organization')
      .set({ country: 'IE' })
      .where('id', '=', 1)
      .execute();

    await expect(service.report(2026)).rejects.toThrow(
      /no health or sports benefit exemption/,
    );
  });

  it('ignores draft and rejected claims, and other years', async () => {
    const claimant = await seedEntity(db, { role: 'employee' });
    for (const [status, periodStart] of [
      ['draft', '2026-03-01'],
      ['rejected', '2026-03-01'],
      ['posted', '2025-03-01'],
    ] as const) {
      await seedAllowance(db, {
        claimantId: claimant.id,
        type: 'health',
        taxFreeAmount: 10000,
        taxableAmount: 0,
        periodStart,
        status,
      });
    }

    const report = await service.report(2026);
    expect(report.inf14PartIii.exemptTotal).toBe(0);
    expect(report.tsdAnnex4.months).toEqual([]);
    expect(report.unresolvedHistoricalClaims).toEqual([]);
    expect(report.readyToFile).toBe(true);
  });
});
