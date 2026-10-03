import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { AllowanceLimitService } from './allowance-limit.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { OrganizationService } from '../organization/organization.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { seedEntity } from '../../test/helpers/seed-entity';
import { seedAllowance } from '../../test/helpers/seed-allowance';
import type { HealthEligibilityFacts } from '../plugins/health-allowance.types';

/** A bare posted voucher, enough to make a claim's money real in the ledger. */
let _voucherNo = 0;
async function seedVoucher(
  db: Kysely<Database>,
  taxPointDate: string,
  reversesId?: number,
): Promise<{ id: number }> {
  return db
    .insertInto('voucher')
    .values({
      voucher_number: `V-${++_voucherNo}`,
      tax_point_date: taxPointDate,
      posted_at: Math.floor(Date.now() / 1000),
      previous_hash: null,
      reverses_id: reversesId ?? null,
      corrects_object_type: null,
      corrects_object_id: null,
      reason: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
}

/**
 * The health/sports exemption: capped, per claimant, per window, conditional
 * (issue #212).
 *
 * The bug this covers classified EVERY health claim as entirely tax-free at any
 * amount, because health fell through to the "employer-defined, no statutory
 * ceiling" path alongside phone and internet. Each test below therefore states
 * an amount and asserts the SPLIT, not just that some limit exists.
 */
describe('AllowanceLimitService — health (issue #212)', () => {
  let db: Kysely<Database>;
  let service: AllowanceLimitService;

  const QUALIFYING: HealthEligibilityFacts = {
    category: 'sports_facility_fee',
    claimantRelation: 'employee',
    supportingDocumentId: null,
    supportingDocumentRef: 'INV-2026-0001',
    providerRegistration: null,
    offeredToAllEmployees: true,
  };

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

    // The exemption is Estonian, so the organisation must be Estonian for the
    // EE plugin to be the one answering.
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
        AllowanceLimitService,
      ],
    }).compile();

    service = module.get(AllowanceLimitService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  const health = (
    claimantId: number,
    inputAmount: number,
    periodStart = '2026-09-01',
    facts: HealthEligibilityFacts | null = QUALIFYING,
    periodEnd?: string,
  ) =>
    service.computeSplit({
      claimantId,
      type: 'health',
      inputAmount,
      periodStart,
      periodEnd,
      domestic: true,
      year: Number(periodStart.slice(0, 4)),
      healthFacts: facts,
    });

  // ── The reported amounts ────────────────────────────────────────────────

  it('400.00 EUR with no prior usage is exempt in full', async () => {
    const claimant = await seedEntity(db, { role: 'employee' });
    const split = await health(claimant.id, 40000);

    expect(split).toMatchObject({
      grossAmount: 40000,
      taxFreeAmount: 40000,
      taxableAmount: 0,
    });
    expect(split.health?.exemptionBasis).toBe('statutory_health_exemption');
    expect(split.health?.limitWindow).toBe('2026');
    expect(split.health?.fringeTax).toBeNull();
  });

  it('401.00 EUR is exempt to 400.00 and taxable on the single euro over', async () => {
    const claimant = await seedEntity(db, { role: 'employee' });
    const split = await health(claimant.id, 40100);

    expect(split.taxFreeAmount).toBe(40000);
    expect(split.taxableAmount).toBe(100);
    // 1.00 benefit → 22/78 income tax → 0.28; social 33% of 1.28 → 0.42
    expect(split.health?.fringeTax?.incomeTax).toBe(28);
    expect(split.health?.fringeTax?.socialTax).toBe(42);
  });

  it('1000.00 EUR — the reported case — is 400 exempt and 600 taxable with employer tax on top', async () => {
    const claimant = await seedEntity(db, { role: 'employee' });
    const split = await health(claimant.id, 100000);

    expect(split.grossAmount).toBe(100000);
    expect(split.taxFreeAmount).toBe(40000);
    expect(split.taxableAmount).toBe(60000);
    expect(split.health?.fringeTax?.incomeTax).toBe(16923);
    expect(split.health?.fringeTax?.socialTax).toBe(25385);
    // The claimant is still paid the full 1000.00; the 423.08 is the
    // employer's own cost ON TOP of it.
    expect(
      split.taxableAmount +
        split.taxFreeAmount +
        (split.health?.fringeTax?.incomeTax ?? 0) +
        (split.health?.fringeTax?.socialTax ?? 0),
    ).toBe(142308);
  });

  // ── Accumulation ────────────────────────────────────────────────────────

  it('a second claim in the same year sees the first one has consumed the cap', async () => {
    const claimant = await seedEntity(db, { role: 'employee' });
    await seedAllowance(db, {
      claimantId: claimant.id,
      type: 'health',
      taxFreeAmount: 25000,
      taxableAmount: 0,
      periodStart: '2026-03-01',
      status: 'posted',
    });

    const split = await health(claimant.id, 30000, '2026-09-01');
    expect(split.taxFreeAmount).toBe(15000);
    expect(split.taxableAmount).toBe(15000);
    expect(split.health?.usedBeforeThisClaim).toBe(25000);
  });

  it('a claim after the cap is fully used is taxable in full, and says why', async () => {
    const claimant = await seedEntity(db, { role: 'employee' });
    await seedAllowance(db, {
      claimantId: claimant.id,
      type: 'health',
      taxFreeAmount: 40000,
      taxableAmount: 0,
      periodStart: '2026-01-15',
      status: 'posted',
    });

    const split = await health(claimant.id, 5000, '2026-11-01');
    expect(split.taxFreeAmount).toBe(0);
    expect(split.taxableAmount).toBe(5000);
    expect(split.health?.exemptionBasis).toBe('limit_exhausted');
  });

  it("one employee's usage never touches another's cap", async () => {
    const alice = await seedEntity(db, { role: 'employee' });
    const bob = await seedEntity(db, { role: 'employee' });
    await seedAllowance(db, {
      claimantId: alice.id,
      type: 'health',
      taxFreeAmount: 40000,
      taxableAmount: 0,
      periodStart: '2026-02-01',
      status: 'posted',
    });

    const split = await health(bob.id, 40000);
    expect(split.taxFreeAmount).toBe(40000);
    expect(split.health?.usedBeforeThisClaim).toBe(0);
  });

  it('the annual cap resets at the year boundary and does not carry over', async () => {
    const claimant = await seedEntity(db, { role: 'employee' });
    await seedAllowance(db, {
      claimantId: claimant.id,
      type: 'health',
      taxFreeAmount: 40000,
      taxableAmount: 0,
      periodStart: '2026-12-31',
      status: 'posted',
    });

    // The next year starts clean — and an unused cap is NOT inherited either:
    // 2027 gets its own 400.00, no more.
    const split = await health(claimant.id, 50000, '2027-01-01');
    expect(split.taxFreeAmount).toBe(40000);
    expect(split.taxableAmount).toBe(10000);
    expect(split.health?.limitWindow).toBe('2027');
  });

  it.each([
    ['draft', 'draft'],
    ['awaiting approval', 'needs_triage'],
    ['rejected', 'rejected'],
    ['cancelled', 'cancelled'],
  ])('a %s claim reserves nothing of the cap', async (_label, status) => {
    const claimant = await seedEntity(db, { role: 'employee' });
    await seedAllowance(db, {
      claimantId: claimant.id,
      type: 'health',
      taxFreeAmount: 40000,
      taxableAmount: 0,
      periodStart: '2026-03-01',
      status,
    });

    const split = await health(claimant.id, 40000, '2026-09-01');
    expect(split.taxFreeAmount).toBe(40000);
    expect(split.health?.usedBeforeThisClaim).toBe(0);
  });

  it('a claim marked cancelled while its voucher is still posted keeps holding its share', async () => {
    const claimant = await seedEntity(db, { role: 'employee' });
    const voucher = await seedVoucher(db, '2026-03-01');
    const row = await seedAllowance(db, {
      claimantId: claimant.id,
      type: 'health',
      taxFreeAmount: 40000,
      taxableAmount: 0,
      periodStart: '2026-03-01',
      status: 'cancelled',
    });
    await db
      .updateTable('allowance')
      .set({ voucher_id: voucher.id })
      .where('id', '=', row.id)
      .execute();

    // The expense is still in the ledger, so the cap is still spent. Freeing it
    // on a status flip alone would let the next claim spend the same 400 twice.
    const split = await health(claimant.id, 40000, '2026-09-01');
    expect(split.taxFreeAmount).toBe(0);
    expect(split.health?.exemptionBasis).toBe('limit_exhausted');
  });

  it("a reversal of the claim's voucher does not quietly hand the cap back", async () => {
    const claimant = await seedEntity(db, { role: 'employee' });
    const voucher = await seedVoucher(db, '2026-03-01');
    const row = await seedAllowance(db, {
      claimantId: claimant.id,
      type: 'health',
      taxFreeAmount: 40000,
      taxableAmount: 0,
      periodStart: '2026-03-01',
      status: 'posted',
    });
    await db
      .updateTable('allowance')
      .set({ voucher_id: voucher.id })
      .where('id', '=', row.id)
      .execute();
    // A counter-voucher exists. It may reverse the whole benefit, or part of
    // it, or itself be reversed further down a chain — none of which this
    // query can tell apart. Releasing a whole year's exemption on that
    // ambiguity is the expensive way to be wrong, so usage stays taken and the
    // report raises the claim for review instead.
    await seedVoucher(db, '2026-04-01', voucher.id);

    const split = await health(claimant.id, 40000, '2026-09-01');
    expect(split.taxFreeAmount).toBe(0);
    expect(split.health?.exemptionBasis).toBe('limit_exhausted');
  });

  it('refuses to measure the EUR limit against books kept in another currency', async () => {
    await db
      .updateTable('organization')
      .set({ base_currency: 'USD' })
      .where('id', '=', 1)
      .execute();
    const claimant = await seedEntity(db, { role: 'employee' });

    await expect(health(claimant.id, 40000)).rejects.toMatchObject({
      code: 'health_limit_currency_mismatch',
    });
  });

  it('a recalculation of an existing claim does not count itself', async () => {
    const claimant = await seedEntity(db, { role: 'employee' });
    const own = await seedAllowance(db, {
      claimantId: claimant.id,
      type: 'health',
      taxFreeAmount: 40000,
      taxableAmount: 0,
      periodStart: '2026-05-01',
      status: 'posted',
    });

    const split = await service.computeSplit({
      claimantId: claimant.id,
      type: 'health',
      inputAmount: 40000,
      periodStart: '2026-05-01',
      domestic: true,
      year: 2026,
      excludeAllowanceId: own.id,
      healthFacts: QUALIFYING,
    });
    expect(split.taxFreeAmount).toBe(40000);
  });

  // ── Eligibility ─────────────────────────────────────────────────────────

  it('a claim recording no eligibility facts is fully taxable and marked as such', async () => {
    const claimant = await seedEntity(db, { role: 'employee' });
    const split = await health(claimant.id, 20000, '2026-09-01', null);

    expect(split.taxFreeAmount).toBe(0);
    expect(split.taxableAmount).toBe(20000);
    expect(split.health?.exemptionBasis).toBe('facts_missing');
  });

  it.each([
    [
      'a category outside the statutory list',
      { ...QUALIFYING, category: 'gym_smoothies' },
    ],
    [
      'a claimant in no employment or board relationship',
      { ...QUALIFYING, claimantRelation: 'other' as const },
    ],
    [
      'a perk not offered to every eligible employee',
      { ...QUALIFYING, offeredToAllEmployees: false },
    ],
    [
      'no supporting document',
      {
        ...QUALIFYING,
        supportingDocumentRef: null,
        supportingDocumentId: null,
      },
    ],
    [
      'a provider-conditional service with no provider registration',
      {
        ...QUALIFYING,
        category: 'registered_healthcare_service',
        providerRegistration: null,
      },
    ],
  ])('%s is taxable in full', async (_label, facts) => {
    const claimant = await seedEntity(db, { role: 'employee' });
    const split = await health(claimant.id, 20000, '2026-09-01', facts);

    expect(split.taxFreeAmount).toBe(0);
    expect(split.taxableAmount).toBe(20000);
    expect(split.health?.exemptionBasis).toBe('ineligible');
    expect(split.health?.reason).toBeTruthy();
  });

  it('a provider-conditional service WITH a registration qualifies', async () => {
    const claimant = await seedEntity(db, { role: 'employee' });
    const split = await health(claimant.id, 20000, '2026-09-01', {
      ...QUALIFYING,
      category: 'registered_healthcare_service',
      providerRegistration: 'L04321',
    });
    expect(split.taxFreeAmount).toBe(20000);
  });

  it('a board member qualifies as well as an employee', async () => {
    const claimant = await seedEntity(db, { role: 'director' });
    const split = await health(claimant.id, 20000, '2026-09-01', {
      ...QUALIFYING,
      claimantRelation: 'board_member',
    });
    expect(split.taxFreeAmount).toBe(20000);
  });

  // ── Historic rules ──────────────────────────────────────────────────────

  it('a 2024 claim is measured against the EUR 100 QUARTERLY cap, not 400 a year', async () => {
    const claimant = await seedEntity(db, { role: 'employee' });
    const split = await health(claimant.id, 40000, '2024-08-01');

    expect(split.taxFreeAmount).toBe(10000);
    expect(split.taxableAmount).toBe(30000);
    expect(split.health?.limitWindow).toBe('2024-Q3');
    // 2024 rates: 20/80 income tax on 300.00 → 75.00; social 33% of 375.00.
    expect(split.health?.fringeTax?.incomeTax).toBe(7500);
    expect(split.health?.fringeTax?.socialTax).toBe(12375);
  });

  it('the quarterly cap is per quarter — a Q2 claim is untouched by Q1 usage', async () => {
    const claimant = await seedEntity(db, { role: 'employee' });
    await seedAllowance(db, {
      claimantId: claimant.id,
      type: 'health',
      taxFreeAmount: 10000,
      taxableAmount: 0,
      periodStart: '2024-02-01',
      status: 'posted',
    });

    const split = await health(claimant.id, 10000, '2024-04-01');
    expect(split.taxFreeAmount).toBe(10000);
    expect(split.health?.limitWindow).toBe('2024-Q2');
  });

  it('the 2025 category expansion does not reach back into 2024', async () => {
    const claimant = await seedEntity(db, { role: 'employee' });
    const massage = {
      ...QUALIFYING,
      category: 'massage',
      providerRegistration: 'L04321',
    };

    const before = await health(claimant.id, 5000, '2024-08-01', massage);
    expect(before.taxFreeAmount).toBe(0);
    expect(before.health?.exemptionBasis).toBe('ineligible');

    const after = await health(claimant.id, 5000, '2025-08-01', massage);
    expect(after.taxFreeAmount).toBe(5000);
  });

  it('a claim older than the verified rules gets no exemption and no invented tax rate', async () => {
    const claimant = await seedEntity(db, { role: 'employee' });
    await expect(health(claimant.id, 5000, '2014-06-01')).rejects.toMatchObject(
      {
        code: 'fringe_benefit_tax_rate_unverified',
      },
    );
  });

  // ── Refusals on contradictory dates ─────────────────────────────────────

  it('refuses a year that disagrees with the claim period', async () => {
    const claimant = await seedEntity(db, { role: 'employee' });
    await expect(
      service.computeSplit({
        claimantId: claimant.id,
        type: 'health',
        inputAmount: 10000,
        periodStart: '2026-09-01',
        domestic: true,
        year: 2025,
        healthFacts: QUALIFYING,
      }),
    ).rejects.toMatchObject({ code: 'health_period_year_mismatch' });
  });

  it('refuses a claim straddling two limit windows', async () => {
    const claimant = await seedEntity(db, { role: 'employee' });
    await expect(
      health(claimant.id, 10000, '2026-12-01', QUALIFYING, '2027-01-31'),
    ).rejects.toMatchObject({ code: 'health_claim_spans_two_limit_windows' });
  });

  // ── Jurisdictions without the exemption ─────────────────────────────────

  it('an organisation on the neutral plugin gets no silent exemption', async () => {
    await db
      .updateTable('organization')
      .set({ country: 'IE' })
      .where('id', '=', 1)
      .execute();
    const claimant = await seedEntity(db, { role: 'employee' });

    const split = await health(claimant.id, 100000);
    expect(split.taxFreeAmount).toBe(0);
    expect(split.taxableAmount).toBe(100000);
    expect(split.health?.exemptionBasis).toBe('no_statutory_exemption');
    // No fringe-benefit tax is asserted for a jurisdiction whose rules this
    // deployment does not have.
    expect(split.health?.fringeTax).toBeNull();
  });

  it('phone and internet are untouched by the health rules', async () => {
    const claimant = await seedEntity(db, { role: 'employee' });
    const split = await service.computeSplit({
      claimantId: claimant.id,
      type: 'phone',
      inputAmount: 100000,
      periodStart: '2026-09-01',
      domestic: true,
      year: 2026,
    });
    expect(split.taxFreeAmount).toBe(100000);
    expect(split.health).toBeUndefined();
  });
});
