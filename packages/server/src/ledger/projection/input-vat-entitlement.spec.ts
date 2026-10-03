import { PrepaymentAllocationRepository } from '../../reconciliation/prepayment-allocation.repository';
import { fxTestProviders } from '../../../test/fx-fixtures';
import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../../database/types';
import { migrations } from '../../database/migrations';
import { VatReportService } from '../../vat-report/vat-report.service';
import { LedgerBalanceService } from '../account/ledger-balance.service';
import { AccountService } from '../account/account.service';
import { OrganizationService } from '../../organization/organization.service';
import { OrgContextResolver } from '../../organization/org-context.resolver';
import { PluginLoader } from '../../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../../plugins/estonia-country.plugin';
import { AuditFindingsService } from '../../audit-findings/audit-findings.service';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { CurrencyService } from '../../currency/currency.service';
import { VoucherRepository } from '../voucher/voucher.repository';
import { VoucherLineRepository } from '../voucher/voucher-line.repository';
import { LedgerValidationService } from '../validation/ledger-validation.service';
import { PostingService } from '../posting/posting.service';
import { PeriodLockService } from '../../reporting-periods/period-lock.service';
import { ReportingPeriodsService } from '../../reporting-periods/reporting-periods.service';
import { StatutorySubmissionService } from '../../statutory-submission/statutory-submission.service';
import { StatutoryReportService } from '../../statutory-report/statutory-report.service';
import { VoucherProjectionService } from './voucher-projection.service';
import { SalesInvoicesService } from '../../sales-invoices/sales-invoices.service';
import { FixedAssetRegistrarService } from '../../fixed-assets/fixed-asset-registrar.service';
import { DraftVoucher, DraftVoucherLine } from '../voucher/types';
import { EconomicFacts } from './types';
import { UnresolvedVatTreatmentError } from '../../plugins/vat-treatment.errors';
import { expectDbRefusal } from '../../../test/expect-db-refusal';

/**
 * Issue #211 — WHETHER input VAT is reclaimable at all, resolved before any
 * VAT_RECEIVABLE exists.
 *
 * The defect these cover: the organisation's VAT registration was recorded and
 * never read on the purchase side, so a non-registered company booked a
 * deductible VAT receivable and declared it in KMD row 5, and a reverse charge
 * self-assessed output VAT and deducted it straight back to zero.
 *
 * Three things are asserted throughout, because getting one right while getting
 * another wrong is the easy failure here:
 *  - the DEDUCTION: what reaches VAT_RECEIVABLE and KMD row 5;
 *  - the COST: non-deductible VAT is not dropped, it increases the expense or
 *    the capitalised asset;
 *  - the TAXABLE BASE: on a reverse charge the output tax stays whole and KMD
 *    rows 1/6/7 keep the value the supplier invoiced — the extra cost must not
 *    inflate them.
 *
 * Real DI, real migrations, the real EE plugin, an isolated in-memory database.
 */
describe('Input-VAT deduction entitlement (issue #211)', () => {
  let db: Kysely<Database>;
  let projection: VoucherProjectionService;
  let organization: OrganizationService;
  let posting: PostingService;
  let vatReports: VatReportService;
  let periods: ReportingPeriodsService;
  let testModule: TestingModule;

  // The EE standard rate is 24% only from 2025-07-01 (it was 22% through
  // 2024-2025-H1), and the reverse charge is self-assessed at the rate in force
  // AT THE TAX POINT. The issue's EUR 124 / EUR 24 example is therefore dated
  // into the 24% era.
  const TAX_POINT = '2025-08-15';
  let periodId: number;

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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        OrganizationService,
        OrgContextResolver,
        NullCountryPlugin,
        EstoniaCountryPlugin,
        // One USD publication on the tax point, so the awkward-cent cases below
        // convert at a rate that does not divide evenly either.
        ...fxTestProviders([
          { quoteCurrency: 'USD', rateDate: TAX_POINT, rate: 1.1737 },
        ]),
        PluginLoader,
        LedgerBalanceService,
        AccountService,
        CurrencyService,
        VoucherRepository,
        VoucherLineRepository,
        LedgerValidationService,
        PostingService,
        PeriodLockService,
        VoucherProjectionService,
        SalesInvoicesService,
        FixedAssetRegistrarService,
        AuditFindingsService,
        AuditLogService,
        VatReportService,
        PrepaymentAllocationRepository,
        StatutorySubmissionService,
        StatutoryReportService,
        ReportingPeriodsService,
      ],
    }).compile();

    testModule = module;
    projection = module.get(VoucherProjectionService);
    organization = module.get(OrganizationService);
    posting = module.get(PostingService);
    vatReports = module.get(VatReportService);
    periods = module.get(ReportingPeriodsService);

    const period = await periods.create({
      name: '2025-Q3',
      start_date: '2025-07-01',
      end_date: '2025-09-30',
    });
    periodId = period.id;
  });

  afterEach(async () => {
    await db.destroy();
  });

  // ── helpers ───────────────────────────────────────────────────────────────

  /** The EE organisation in a named VAT state. */
  const orgIs = (patch: {
    vat_registered: boolean;
    vat_registration_kind?: 'ordinary' | 'limited';
    input_vat_entitlement?: 'full' | 'partial' | 'none';
    input_vat_deduction_permille?: number | null;
  }) => organization.updateOrganization({ country: 'EE', ...patch });

  const domesticPurchase = (
    gross: number,
    vat: number,
    extra: Partial<EconomicFacts> = {},
  ): EconomicFacts => ({
    category: 'software',
    grossAmount: gross,
    vatAmount: vat,
    currency: 'EUR',
    taxPointDate: TAX_POINT,
    ...extra,
  });

  /** A reverse-charged acquisition from a taxable person of another member state. */
  const intraEuAcquisition = (
    net: number,
    extra: Partial<EconomicFacts> = {},
  ): EconomicFacts => ({
    category: 'software',
    grossAmount: net,
    vatAmount: 0,
    currency: 'EUR',
    taxPointDate: TAX_POINT,
    supplierCountry: 'DE',
    goodsVsServices: 'services',
    taxStatus: 'taxable_business',
    ...extra,
  });

  const debits = (d: DraftVoucher, code: string): DraftVoucherLine[] =>
    d.lines.filter((l) => l.account_code === code && l.is_debit);

  const sumAmount = (lines: DraftVoucherLine[]) =>
    lines.reduce((t, l) => t + l.amount, 0);

  /** Both sides must balance in the DOCUMENT currency and in the BASE currency. */
  const expectBalanced = (d: DraftVoucher) => {
    const side = (isDebit: boolean, field: 'amount' | 'base_amount') =>
      d.lines
        .filter((l) => l.is_debit === isDebit)
        .reduce((t, l) => t + l[field], 0);
    expect(side(true, 'amount')).toBe(side(false, 'amount'));
    expect(side(true, 'base_amount')).toBe(side(false, 'base_amount'));
    // A leg of zero is forbidden by the voucher_line CHECK, so it must have
    // been elided rather than emitted.
    for (const l of d.lines) expect(l.amount).toBeGreaterThan(0);
  };

  const declaration = async () => vatReports.buildDeclaration(periodId);

  // ── Domestic purchase: the issue's own reproduction ───────────────────────

  describe('domestic purchase (EUR 124 gross, EUR 24 VAT)', () => {
    it('an ordinary non-registered organisation books the whole 124 as cost and declares no input VAT', async () => {
      await orgIs({ vat_registered: false });

      const draft = await projection.project(
        domesticPurchase(12400, 2400),
        'purchase',
      );

      // The exact defect: there is no VAT_RECEIVABLE leg at all, and the
      // EUR 24 is in the expense rather than lost.
      expect(debits(draft, 'VAT_RECEIVABLE')).toHaveLength(0);
      expect(sumAmount(debits(draft, 'EXPENSE_SOFTWARE'))).toBe(12400);
      // The leg keeps the code: the purchase DID bear Estonian 24% input VAT,
      // we simply may not deduct it. Row 5 is fed by VAT_RECEIVABLE, so the
      // code costs nothing on the return and keeps the treatment visible.
      expect(debits(draft, 'EXPENSE_SOFTWARE')[0].vat_code).toBe('EE_INPUT_24');
      expectBalanced(draft);

      await posting.postVoucher(draft);
      expect((await declaration()).row5_input_vat).toBe(0);
    });

    it('a fully entitled organisation deducts all of it (100 cost / 24 input)', async () => {
      await orgIs({ vat_registered: true });

      const draft = await projection.project(
        domesticPurchase(12400, 2400),
        'purchase',
      );

      expect(sumAmount(debits(draft, 'EXPENSE_SOFTWARE'))).toBe(10000);
      expect(sumAmount(debits(draft, 'VAT_RECEIVABLE'))).toBe(2400);
      expectBalanced(draft);

      await posting.postVoucher(draft);
      expect((await declaration()).row5_input_vat).toBe(2400);
    });

    it('a 50% partial entitlement deducts half and costs the rest (112 cost / 12 input)', async () => {
      await orgIs({
        vat_registered: true,
        input_vat_entitlement: 'partial',
        input_vat_deduction_permille: 500,
      });

      const draft = await projection.project(
        domesticPurchase(12400, 2400),
        'purchase',
      );

      expect(sumAmount(debits(draft, 'EXPENSE_SOFTWARE'))).toBe(11200);
      expect(sumAmount(debits(draft, 'VAT_RECEIVABLE'))).toBe(1200);
      expectBalanced(draft);

      await posting.postVoucher(draft);
      expect((await declaration()).row5_input_vat).toBe(1200);
    });

    it('an explicit zero entitlement costs all of it, like no registration (124 cost / 0 input)', async () => {
      await orgIs({ vat_registered: true, input_vat_entitlement: 'none' });

      const draft = await projection.project(
        domesticPurchase(12400, 2400),
        'purchase',
      );

      expect(debits(draft, 'VAT_RECEIVABLE')).toHaveLength(0);
      expect(sumAmount(debits(draft, 'EXPENSE_SOFTWARE'))).toBe(12400);
      expectBalanced(draft);

      await posting.postVoucher(draft);
      expect((await declaration()).row5_input_vat).toBe(0);
    });

    it('a limited registration deducts nothing, although it IS registered', async () => {
      await orgIs({
        vat_registered: true,
        vat_registration_kind: 'limited',
        input_vat_entitlement: 'none',
      });

      const draft = await projection.project(
        domesticPurchase(12400, 2400),
        'purchase',
      );

      expect(debits(draft, 'VAT_RECEIVABLE')).toHaveLength(0);
      expect(sumAmount(debits(draft, 'EXPENSE_SOFTWARE'))).toBe(12400);
      expect(draft.input_vat_entitlement?.basis).toBe('limited_registration');
    });

    it('a receipt that is not addressed to the organisation reclaims nothing even at full entitlement', async () => {
      await orgIs({ vat_registered: true });

      const draft = await projection.project(
        domesticPurchase(12400, 2400, {
          claimantId: 1,
          companyAddressedReceipt: false,
        }),
        'purchase',
      );

      expect(debits(draft, 'VAT_RECEIVABLE')).toHaveLength(0);
      expect(sumAmount(debits(draft, 'CLAIMANT_PAYABLE'))).toBe(0);
      expect(sumAmount(debits(draft, 'EXPENSE_SOFTWARE'))).toBe(12400);
      // The provenance records the EFFECTIVE reason, not the settings alone:
      // the entitlement existed, the document did not support using it.
      expect(draft.input_vat_entitlement?.basis).toBe(
        'receipt_not_company_addressed',
      );
    });
  });

  // ── Reverse charge: the output stays whole, the BASE stays the base ───────

  describe('reverse-charged intra-EU acquisition (EUR 100 net)', () => {
    it('a non-registered organisation owes the full 24 output and deducts none of it, and the declared base is still 100', async () => {
      await orgIs({ vat_registered: false });

      const draft = await projection.project(
        intraEuAcquisition(10000),
        'purchase',
      );

      // The cost is 124: the acquisition plus the tax it cannot reclaim.
      expect(sumAmount(debits(draft, 'EXPENSE_SOFTWARE'))).toBe(12400);
      expect(debits(draft, 'VAT_RECEIVABLE')).toHaveLength(0);
      // The irrecoverable part carries NO VAT code — this is what keeps it out
      // of the taxable base.
      const coded = debits(draft, 'EXPENSE_SOFTWARE').filter(
        (l) => l.vat_code !== null,
      );
      expect(sumAmount(coded)).toBe(10000);
      expectBalanced(draft);

      await posting.postVoucher(draft);
      const d = await declaration();
      expect(d.row4_output_vat).toBe(2400); // self-assessed in full
      expect(d.row5_input_vat).toBe(0); // and not deducted back
      expect(d.row6_intra_eu_acquisition).toBe(10000); // NOT 12400
      expect(d.row1_base_24).toBe(10000);
      expect(d.net_vat_due).toBe(2400);
    });

    it('a 50% partial entitlement deducts half the self-assessed tax, and still declares a base of 100', async () => {
      await orgIs({
        vat_registered: true,
        input_vat_entitlement: 'partial',
        input_vat_deduction_permille: 500,
      });

      const draft = await projection.project(
        intraEuAcquisition(10000),
        'purchase',
      );

      expect(sumAmount(debits(draft, 'EXPENSE_SOFTWARE'))).toBe(11200);
      expect(sumAmount(debits(draft, 'VAT_RECEIVABLE'))).toBe(1200);
      expectBalanced(draft);

      await posting.postVoucher(draft);
      const d = await declaration();
      expect(d.row4_output_vat).toBe(2400);
      expect(d.row5_input_vat).toBe(1200);
      expect(d.row6_intra_eu_acquisition).toBe(10000);
      expect(d.row1_base_24).toBe(10000);
      expect(d.net_vat_due).toBe(1200);
    });

    it('full recovery is unchanged: 100 cost, 24 out, 24 in, net zero', async () => {
      await orgIs({ vat_registered: true });

      const draft = await projection.project(
        intraEuAcquisition(10000),
        'purchase',
      );

      expect(sumAmount(debits(draft, 'EXPENSE_SOFTWARE'))).toBe(10000);
      expect(sumAmount(debits(draft, 'VAT_RECEIVABLE'))).toBe(2400);
      expectBalanced(draft);

      await posting.postVoucher(draft);
      const d = await declaration();
      expect(d.row4_output_vat).toBe(2400);
      expect(d.row5_input_vat).toBe(2400);
      expect(d.row6_intra_eu_acquisition).toBe(10000);
      expect(d.net_vat_due).toBe(0);
    });

    it('self-assesses at the rate in force at the TAX POINT, not today’s', async () => {
      await orgIs({ vat_registered: true });

      // 2024 sat in the 22% era; the rate rose to 24% on 2025-07-01.
      const draft = await projection.project(
        intraEuAcquisition(10000, { taxPointDate: '2024-02-15' }),
        'purchase',
      );

      const output = draft.lines.find(
        (l) => l.account_code === 'VAT_PAYABLE' && !l.is_debit,
      );
      expect(output!.amount).toBe(2200);
      expectBalanced(draft);
    });
  });

  // ── Asset cost ────────────────────────────────────────────────────────────

  // The DRAFT side of capitalisation. That the fixed-asset REGISTER then picks
  // up both legs — the registrar sums the capex debits rather than taking the
  // first — is asserted against a really-posted voucher in
  // test/input-vat-entitlement.e2e-spec.ts, since it is the registrar's job,
  // not the projection's.
  it('puts irrecoverable VAT on the asset account, not into an expense', async () => {
    await orgIs({ vat_registered: false });

    const draft = await projection.project(
      { ...domesticPurchase(12400, 2400), category: 'it_equipment' },
      'purchase',
    );

    const assetLegs = draft.lines.filter(
      (l) => l.is_debit && l.account_code.startsWith('FIXED_ASSETS'),
    );
    expect(assetLegs.length).toBeGreaterThan(0);
    expect(sumAmount(assetLegs)).toBe(12400);
    expectBalanced(draft);
  });

  // ── Provenance ────────────────────────────────────────────────────────────

  it('freezes the entitlement onto the posted voucher, and a later settings change does not restate it', async () => {
    await orgIs({
      vat_registered: true,
      input_vat_entitlement: 'partial',
      input_vat_deduction_permille: 500,
    });

    const posted = await posting.postVoucher(
      await projection.project(domesticPurchase(12400, 2400), 'purchase'),
    );

    const read = async () =>
      db
        .selectFrom('voucher')
        .select([
          'input_vat_entitlement_basis',
          'input_vat_deduction_numerator',
          'input_vat_deduction_denominator',
        ])
        .where('id', '=', posted.id)
        .executeTakeFirstOrThrow();

    expect(await read()).toEqual({
      input_vat_entitlement_basis: 'partial',
      input_vat_deduction_numerator: 500,
      input_vat_deduction_denominator: 1000,
    });

    // The organisation's entitlement changes. The posted voucher does not.
    await orgIs({ vat_registered: true, input_vat_entitlement: 'full' });
    expect(await read()).toEqual({
      input_vat_entitlement_basis: 'partial',
      input_vat_deduction_numerator: 500,
      input_vat_deduction_denominator: 1000,
    });
    expect((await declaration()).row5_input_vat).toBe(1200);
  });

  // ── FX + partial: the partition cannot drift ──────────────────────────────

  it('keeps an awkward partial split balanced in BOTH currencies', async () => {
    await orgIs({
      vat_registered: true,
      input_vat_entitlement: 'partial',
      // A third, against amounts that do not divide — the case where two
      // independently rounded halves would disagree with the whole.
      input_vat_deduction_permille: 333,
    });

    for (const [gross, vat, currency] of [
      [12333, 2333, 'EUR'],
      [10001, 1917, 'USD'],
      [99, 19, 'USD'],
      [7, 1, 'USD'],
    ] as const) {
      const draft = await projection.project(
        domesticPurchase(gross, vat, { currency }),
        'purchase',
      );
      expectBalanced(draft);
      // The deductible and the cost still account for every cent of the gross.
      expect(
        sumAmount(debits(draft, 'EXPENSE_SOFTWARE')) +
          sumAmount(debits(draft, 'VAT_RECEIVABLE')),
      ).toBe(gross);
    }
  });

  it('keeps an awkward partial reverse charge balanced in BOTH currencies', async () => {
    await orgIs({
      vat_registered: true,
      input_vat_entitlement: 'partial',
      input_vat_deduction_permille: 333,
    });

    for (const [net, currency] of [
      [10001, 'EUR'],
      [3337, 'USD'],
      [7, 'USD'],
    ] as const) {
      const draft = await projection.project(
        intraEuAcquisition(net, { currency }),
        'purchase',
      );
      expectBalanced(draft);
      const output = draft.lines.find(
        (l) => l.account_code === 'VAT_PAYABLE' && !l.is_debit,
      );
      // Whatever the split, the output tax is the whole self-assessed amount
      // and the coded base is exactly the acquisition.
      expect(output!.amount).toBe(Math.round(net * 0.24));
      const coded = debits(draft, 'EXPENSE_SOFTWARE').filter(
        (l) => l.vat_code !== null,
      );
      expect(sumAmount(coded)).toBe(net);
    }
  });

  // ── Refusals ──────────────────────────────────────────────────────────────

  describe('refusals — a proportion that cannot be computed is never guessed', () => {
    it('cannot even record a partial entitlement without its proportion — the database refuses it', async () => {
      await orgIs({ vat_registered: true });

      await expectDbRefusal(
        () =>
          db
            .updateTable('organization')
            .set({ input_vat_entitlement: 'partial' })
            .execute(),
        /CHECK constraint failed/,
      );

      // And the settings are untouched, so nothing half-applied.
      const org = await organization.getOrganization();
      expect(org.input_vat_entitlement).toBe('full');
      expect(org.input_vat_deduction_permille).toBeNull();
    });

    it('refuses to post on a proportion that is not a usable fraction', async () => {
      // The plugin is asked directly: this is the state a row would be in if it
      // reached the posting path without a proportion, and the answer must be a
      // refusal naming the field rather than a deduction of zero (which would
      // look like a deliberate no-entitlement setting) or of everything.
      const plugin = testModule.get(EstoniaCountryPlugin);
      expect(() =>
        plugin.resolveInputVatEntitlement(
          {
            country: 'EE',
            vatRegistered: true,
            baseCurrency: null,
            vatRegistrationKind: 'ordinary',
            inputVatEntitlement: 'partial',
            inputVatDeductionPermille: null,
          },
          { treatment: 'domestic', vatCode: 'EE_INPUT_24' },
        ),
      ).toThrow(UnresolvedVatTreatmentError);
    });

    it('refuses an entitlement that contradicts the registration, rather than silently deducting nothing', async () => {
      await orgIs({ vat_registered: true });
      await db.updateTable('organization').set({ vat_registered: 0 }).execute();

      await expect(
        projection.project(domesticPurchase(12400, 2400), 'purchase'),
      ).rejects.toThrow(/not VAT-registered/);
    });

    it('refuses to auto-classify a SALE made under a limited registration', async () => {
      await orgIs({
        vat_registered: true,
        vat_registration_kind: 'limited',
        input_vat_entitlement: 'none',
      });

      await expect(
        projection.project(
          {
            category: 'revenue',
            grossAmount: 12400,
            vatAmount: 2400,
            currency: 'EUR',
            taxPointDate: TAX_POINT,
            supplierCountry: 'EE',
            goodsVsServices: 'services',
            taxStatus: 'taxable_business',
          },
          'sale',
        ),
      ).rejects.toThrow(/limited taxable person/);
    });
  });
  // ── Incoherent source amounts, at EVERY entitlement ──────────────────────

  describe('a document whose stated VAT exceeds its gross', () => {
    /**
     * This is refused on the SOURCE amounts, before any treatment is chosen.
     * It used to be caught only because the net went negative and structural
     * validation rejected a negative line — which stops happening the moment a
     * non-deductible purchase books its tax into the cost, since 100 gross with
     * 200 VAT then becomes a perfectly postable cost of 100. So it is asserted
     * at every entitlement, and on the reverse-charge path too.
     */
    const states = [
      { name: 'not registered', patch: { vat_registered: false } },
      { name: 'fully entitled', patch: { vat_registered: true } },
      {
        name: 'partially entitled',
        patch: {
          vat_registered: true,
          input_vat_entitlement: 'partial' as const,
          input_vat_deduction_permille: 500,
        },
      },
      {
        name: 'explicitly not entitled',
        patch: {
          vat_registered: true,
          input_vat_entitlement: 'none' as const,
        },
      },
    ];

    for (const { name, patch } of states) {
      it(`refuses it when the organisation is ${name}`, async () => {
        await orgIs(patch);
        await expect(
          projection.project(domesticPurchase(100, 200), 'purchase'),
        ).rejects.toThrow(/cannot exceed its gross amount/);
      });
    }

    it('refuses it on the reverse-charge path as well', async () => {
      await orgIs({ vat_registered: true });
      await expect(
        projection.project(
          intraEuAcquisition(100, { vatAmount: 200 }),
          'purchase',
        ),
      ).rejects.toThrow(/cannot exceed its gross amount/);
    });

    it('refuses a non-positive gross and a negative tax', async () => {
      await orgIs({ vat_registered: true });
      await expect(
        projection.project(domesticPurchase(0, 0), 'purchase'),
      ).rejects.toThrow(/positive gross amount/);
      await expect(
        projection.project(domesticPurchase(1000, -1), 'purchase'),
      ).rejects.toThrow(/cannot be negative/);
    });

    it('still posts a legitimate wholly non-recoverable purchase', async () => {
      await orgIs({ vat_registered: false });
      const draft = await projection.project(
        domesticPurchase(12400, 2400),
        'purchase',
      );
      expectBalanced(draft);
      expect(sumAmount(debits(draft, 'EXPENSE_SOFTWARE'))).toBe(12400);
    });
  });
});
