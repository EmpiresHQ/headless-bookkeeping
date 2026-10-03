import { FX_RATE_SOURCE } from '../src/fx/fx-rate.types';
import { ECB_FIXTURE_RATES, FixtureFxRateSource } from './fx-fixtures';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../src/database/types';
import { migrations } from '../src/database/migrations';
import { DOCUMENT_STORAGE_ROOT } from '../src/documents/document-storage.service';
import { AppModule } from '../src/app.module';
import { MastraService } from '../src/ai/mastra.service';
import { fauxMastraService } from './faux-mastra.service';
import { KmdDeclaration } from '../src/vat-report/types';
import request from 'supertest';
import { App } from 'supertest/types';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { ExpensesService } from '../src/expenses/expenses.service';
import { SalesInvoicesService } from '../src/sales-invoices/sales-invoices.service';
import { validateAgainstKmdXsd } from '../src/plugins/estonia-kmd/xsd-validate';

const xsd = readFileSync(
  join(__dirname, 'fixtures/vatdeclaration.xsd'),
  'utf8',
);

/**
 * Input-VAT deduction entitlement over real HTTP (issue #211).
 *
 * Two things only an end-to-end run can show:
 *  - the SETTINGS surface refuses the combinations that would otherwise reach
 *    a column CHECK as a 500, and refuses them WITHOUT half-applying anything;
 *  - an expense entered over the API by a non-registered organisation reaches
 *    the ledger and the declaration with the tax in its cost and nothing in
 *    KMD row 5 — the bug report's own path, not a projection unit test.
 */
describe('Input-VAT entitlement (E2E)', () => {
  let app: INestApplication<App>;
  let db: Kysely<Database>;
  let root: string;
  let token: string;

  const TAX_POINT = '2026-05-15';
  const PERIOD = { name: '2026-05', start: '2026-05-01', end: '2026-05-31' };

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const http = () => request(app.getHttpServer());

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

    await db
      .insertInto('policy_config')
      .values({ key: 'auto_post_enabled', value: 'true', updated_at: 0 })
      .execute();

    root = mkdtempSync(join(tmpdir(), 'input-vat-entitlement-e2e-'));

    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(KYSELY_MODULE_CONNECTION_TOKEN())
      .useValue(db)
      .overrideProvider(DOCUMENT_STORAGE_ROOT)
      .useValue(root)
      .overrideProvider(MastraService)
      .useValue(fauxMastraService)
      .overrideProvider(FX_RATE_SOURCE)
      .useValue(
        new FixtureFxRateSource([
          ...ECB_FIXTURE_RATES,
          // A USD publication on the tax point, deliberately at 0.5 USD per
          // EUR. At that rate a document's own VAT and the HALF of it a 50%
          // entitlement deducts in base currency are the SAME number — the
          // coincidence that would hide a base-vs-document currency mix-up.
          { quoteCurrency: 'USD', rateDate: TAX_POINT, rate: 0.5 },
        ]),
      )
      .compile();

    app = module.createNestApplication();
    await app.init();

    token = 'test-token-input-vat-12345';
    await db
      .insertInto('api_token')
      .values({
        token_hash: createHash('sha256').update(token).digest('hex'),
        label: 'e2e-input-vat',
      })
      .execute();

    await http()
      .put('/api/organization')
      .set(auth())
      .send({
        country: 'EE',
        vat_registered: true,
        vat_registration_number: 'EE100000001',
        registry_code: '17499653',
        name: 'Test OÜ',
      })
      .expect(200);
    await http()
      .post('/api/reporting-periods')
      .set(auth())
      .send({
        name: PERIOD.name,
        start_date: PERIOD.start,
        end_date: PERIOD.end,
      })
      .expect(201);
  });

  afterEach(async () => {
    await app.close();
    await db.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  const org = async () =>
    (await http().get('/api/organization').set(auth()).expect(200)).body as {
      vat_registered: boolean;
      vat_registration_kind: string;
      input_vat_entitlement: string;
      input_vat_deduction_permille: number | null;
    };

  const putOrg = (body: Record<string, unknown>) =>
    http().put('/api/organization').set(auth()).send(body);

  async function declaration(): Promise<KmdDeclaration> {
    const periods = (
      await http().get('/api/reporting-periods').set(auth()).expect(200)
    ).body as { reportingPeriods: { id: number; name: string }[] };
    const id = periods.reportingPeriods.find((p) => p.name === PERIOD.name)!.id;
    const res = await http()
      .get(`/api/reporting-periods/${id}/kmd`)
      .set(auth())
      .expect(200);
    return res.body as KmdDeclaration;
  }

  async function addSupplier(body: Record<string, unknown>): Promise<number> {
    const res = await http()
      .post('/api/entities')
      .set(auth())
      .send({ role: 'supplier', ...body })
      .expect(201);
    return (res.body as { id: number }).id;
  }

  async function createExpense(body: Record<string, unknown>): Promise<number> {
    const res = await http()
      .post('/api/expenses')
      .set(auth())
      .send({ currency: 'EUR', tax_point_date: TAX_POINT, ...body })
      .expect(201);
    return (res.body as { id: number }).id;
  }

  const postExpense = (id: number) =>
    http().post(`/api/expenses/${id}/post`).set(auth()).send({});

  /**
   * Post an expense and, when the policy holds it for approval (these INF cases
   * are deliberately over the €1000 threshold, which is also over the auto-post
   * limit), approve it so a voucher actually exists to report.
   */
  async function postAndSettle(id: number): Promise<void> {
    await postExpense(id).expect(201);
    const pending = await db
      .selectFrom('approval')
      .selectAll()
      .where('object_type', '=', 'expense')
      .where('object_id', '=', id)
      .where('status', '=', 'pending')
      .execute();
    for (const approval of pending) {
      await http()
        .post(`/api/approvals/${approval.id}/approve`)
        .set(auth())
        .send({ approved_by: 'owner@e2e' })
        .expect(201);
    }
  }

  /** Debit total booked to one account code, across every posted voucher. */
  async function debitTotal(code: string): Promise<number> {
    const rows = await db
      .selectFrom('voucher_line as vl')
      .innerJoin('account as a', 'a.id', 'vl.account_id')
      .select(['vl.base_amount', 'vl.is_debit'])
      .where('a.code', '=', code)
      .execute();
    return rows.reduce(
      (t, l) => t + (l.is_debit ? l.base_amount : -l.base_amount),
      0,
    );
  }

  // ── The settings surface ─────────────────────────────────────────────────

  describe('PUT /api/organization refuses impossible VAT states', () => {
    /** Every rejection must leave the stored settings exactly as they were. */
    const expectRejectedAndUnchanged = async (
      body: Record<string, unknown>,
    ) => {
      const before = await org();
      await putOrg(body).expect(400);
      expect(await org()).toEqual(before);
    };

    it('rejects an unknown entitlement rather than letting it reach the column CHECK', async () => {
      await expectRejectedAndUnchanged({ input_vat_entitlement: 'half' });
    });

    it('rejects an unknown registration kind', async () => {
      await expectRejectedAndUnchanged({ vat_registration_kind: 'special' });
    });

    it('rejects a partial entitlement with no proportion', async () => {
      await expectRejectedAndUnchanged({ input_vat_entitlement: 'partial' });
    });

    it('rejects a proportion that is negative, over 1000, or not a whole number', async () => {
      for (const permille of [-1, 1001, 12.5]) {
        await expectRejectedAndUnchanged({
          input_vat_entitlement: 'partial',
          input_vat_deduction_permille: permille,
        });
      }
    });

    it('rejects a proportion sent alongside a non-partial entitlement', async () => {
      await expectRejectedAndUnchanged({
        input_vat_entitlement: 'full',
        input_vat_deduction_permille: 500,
      });
    });

    it('rejects a deduction entitlement on an organisation that is not registered', async () => {
      await expectRejectedAndUnchanged({
        vat_registered: false,
        input_vat_entitlement: 'partial',
        input_vat_deduction_permille: 500,
      });
    });

    it('rejects a deduction entitlement on a LIMITED registration', async () => {
      await expectRejectedAndUnchanged({
        vat_registration_kind: 'limited',
        input_vat_entitlement: 'full',
      });
    });
  });

  describe('PUT /api/organization keeps pre-#211 callers working', () => {
    it('deregistering alone produces a legitimate no-entitlement state', async () => {
      await putOrg({ vat_registered: false }).expect(200);
      expect(await org()).toMatchObject({
        vat_registered: false,
        input_vat_entitlement: 'none',
        input_vat_deduction_permille: null,
      });
    });

    it('registering alone produces the ordinary full entitlement', async () => {
      await putOrg({ vat_registered: false }).expect(200);
      await putOrg({ vat_registered: true }).expect(200);
      expect(await org()).toMatchObject({
        vat_registered: true,
        vat_registration_kind: 'ordinary',
        input_vat_entitlement: 'full',
        input_vat_deduction_permille: null,
      });
    });

    it('leaving a partial entitlement clears the proportion — no stale permille', async () => {
      await putOrg({
        input_vat_entitlement: 'partial',
        input_vat_deduction_permille: 500,
      }).expect(200);
      expect((await org()).input_vat_deduction_permille).toBe(500);

      await putOrg({ input_vat_entitlement: 'full' }).expect(200);
      expect(await org()).toMatchObject({
        input_vat_entitlement: 'full',
        input_vat_deduction_permille: null,
      });
    });

    it('switching to a limited registration carries the entitlement to none in the same call', async () => {
      await putOrg({ vat_registration_kind: 'limited' }).expect(200);
      expect(await org()).toMatchObject({
        vat_registration_kind: 'limited',
        input_vat_entitlement: 'none',
        input_vat_deduction_permille: null,
      });
    });
  });

  // ── The bug report's own path, over HTTP ─────────────────────────────────

  describe('an expense entered by a non-registered organisation', () => {
    it('costs the whole gross and declares no input VAT', async () => {
      await putOrg({ vat_registered: false }).expect(200);

      const expense = (
        await http()
          .post('/api/expenses')
          .set(auth())
          .send({
            category: 'software',
            gross_amount: 12400,
            vat_amount: 2400,
            currency: 'EUR',
            tax_point_date: TAX_POINT,
          })
          .expect(201)
      ).body as { id: number };

      await http()
        .post(`/api/expenses/${expense.id}/post`)
        .set(auth())
        .send({})
        .expect(201);

      // Nothing was booked to the VAT-receivable control account…
      const receivable = await db
        .selectFrom('voucher_line as vl')
        .innerJoin('account as a', 'a.id', 'vl.account_id')
        .select(['vl.base_amount'])
        .where('a.code', '=', 'VAT_RECEIVABLE')
        .execute();
      expect(receivable).toHaveLength(0);

      // …the tax is in the cost…
      const expenseLegs = await db
        .selectFrom('voucher_line as vl')
        .innerJoin('account as a', 'a.id', 'vl.account_id')
        .select(['vl.base_amount'])
        .where('a.code', '=', 'EXPENSE_SOFTWARE')
        .where('vl.is_debit', '=', 1)
        .execute();
      expect(expenseLegs.reduce((t, l) => t + l.base_amount, 0)).toBe(12400);

      // …and the declaration claims none of it.
      expect((await declaration()).row5_input_vat).toBe(0);
    });
  });

  // ── Capitalisation: the REGISTER must carry what the asset cost ──────────

  describe('a reverse-charged capex acquisition (EUR 100 of IT equipment)', () => {
    /** A DE taxable-person supplier, so the purchase reverse-charges. */
    const euSupplier = () =>
      addSupplier({
        country: 'DE',
        name: 'Hardware GmbH',
        registrationKey: 'DE811111111',
        goodsVsServices: 'services',
        taxStatus: 'taxable_business',
      });

    it('registers the asset at 124 when none of the self-assessed VAT is recoverable', async () => {
      await putOrg({ vat_registered: false }).expect(200);
      const supplier = await euSupplier();

      const id = await createExpense({
        category: 'it_equipment',
        gross_amount: 10000,
        vat_amount: 0,
        supplier_id: supplier,
        asset_name: 'Workshop laptop',
      });
      await postExpense(id).expect(201);

      // The register — not just the draft — carries the full cost. This is the
      // assertion that fails if the registrar goes back to taking the FIRST
      // capex debit instead of summing them.
      const asset = await db
        .selectFrom('fixed_asset')
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(asset.name).toBe('Workshop laptop');
      expect(asset.cost_base_minor).toBe(12400);
      expect(await debitTotal('FIXED_ASSETS_IT')).toBe(12400);

      // …while the declaration still shows the acquisition the supplier made,
      // with the tax payable in full and none of it deducted.
      const d = await declaration();
      expect(d.row6_intra_eu_acquisition).toBe(10000);
      expect(d.row1_base_24).toBe(10000);
      expect(d.row4_output_vat).toBe(2400);
      expect(d.row5_input_vat).toBe(0);
    });

    it('registers the asset at 112 on a 50% entitlement, deducting the other half', async () => {
      await putOrg({
        input_vat_entitlement: 'partial',
        input_vat_deduction_permille: 500,
      }).expect(200);
      const supplier = await euSupplier();

      const id = await createExpense({
        category: 'it_equipment',
        gross_amount: 10000,
        vat_amount: 0,
        supplier_id: supplier,
        asset_name: 'Shared laptop',
      });
      await postExpense(id).expect(201);

      const asset = await db
        .selectFrom('fixed_asset')
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(asset.cost_base_minor).toBe(11200);
      expect(await debitTotal('FIXED_ASSETS_IT')).toBe(11200);

      const d = await declaration();
      expect(d.row6_intra_eu_acquisition).toBe(10000);
      expect(d.row4_output_vat).toBe(2400);
      expect(d.row5_input_vat).toBe(1200);
    });

    it('registers it at 100 when fully entitled — unchanged from before', async () => {
      const supplier = await euSupplier();
      const id = await createExpense({
        category: 'it_equipment',
        gross_amount: 10000,
        vat_amount: 0,
        supplier_id: supplier,
        asset_name: 'Office laptop',
      });
      await postExpense(id).expect(201);

      const asset = await db
        .selectFrom('fixed_asset')
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(asset.cost_base_minor).toBe(10000);
      const d = await declaration();
      expect(d.row5_input_vat).toBe(2400);
      expect(d.row4_output_vat).toBe(2400);
    });
  });

  // ── Correction after the entitlement changed ─────────────────────────────

  describe('correcting a purchase after the entitlement changed', () => {
    it('reverses the ORIGINAL amounts on the original entitlement, and reposts on the current one', async () => {
      await putOrg({
        input_vat_entitlement: 'partial',
        input_vat_deduction_permille: 500,
      }).expect(200);

      const id = await createExpense({
        category: 'software',
        gross_amount: 12400,
        vat_amount: 2400,
      });
      await postExpense(id).expect(201);

      const original = await db
        .selectFrom('voucher')
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(original.input_vat_entitlement_basis).toBe('partial');
      expect(original.input_vat_deduction_numerator).toBe(500);
      expect(original.input_vat_deduction_denominator).toBe(1000);
      expect(await debitTotal('VAT_RECEIVABLE')).toBe(1200);

      // The organisation's entitlement moves to full BEFORE the correction.
      await putOrg({ input_vat_entitlement: 'full' }).expect(200);

      await http()
        .post(`/api/expenses/${id}/correct`)
        .set(auth())
        .send({
          kind: 'financial',
          reason: 'restated after entitlement review',
        })
        .expect(201);

      const vouchers = await db
        .selectFrom('voucher')
        .selectAll()
        .orderBy('id')
        .execute();
      expect(vouchers).toHaveLength(3);
      const [, reversal, replacement] = vouchers;

      // The reversal COPIES what the original was posted at — it takes back
      // the 12 that was actually deducted, not the 24 today's settings imply.
      expect(reversal.reverses_id).toBe(original.id);
      expect(reversal.input_vat_entitlement_basis).toBe('partial');
      expect(reversal.input_vat_deduction_numerator).toBe(500);
      expect(reversal.input_vat_deduction_denominator).toBe(1000);

      // The replacement is composed on the CURRENT entitlement.
      expect(replacement.input_vat_entitlement_basis).toBe('full');
      expect(replacement.input_vat_deduction_numerator).toBe(1);
      expect(replacement.input_vat_deduction_denominator).toBe(1);

      // Net of all three: the original 12 came back out and 24 went in.
      expect(await debitTotal('VAT_RECEIVABLE')).toBe(2400);
      expect(await debitTotal('EXPENSE_SOFTWARE')).toBe(10000);
      expect((await declaration()).row5_input_vat).toBe(2400);
    });
  });

  // ── The fiscal EXPORT, not just the JSON declaration ─────────────────────

  describe('the KMD export of a partially deducted reverse charge', () => {
    it('reports the full self-assessed output, only the deductible input, and the invoiced base', async () => {
      await putOrg({
        input_vat_entitlement: 'partial',
        input_vat_deduction_permille: 500,
      }).expect(200);
      const supplier = await addSupplier({
        country: 'DE',
        name: 'Cloud GmbH',
        registrationKey: 'DE822222222',
        goodsVsServices: 'services',
        taxStatus: 'taxable_business',
      });

      const id = await createExpense({
        category: 'software',
        gross_amount: 10000,
        vat_amount: 0,
        supplier_id: supplier,
      });
      await postExpense(id).expect(201);

      const d = await declaration();
      expect(d.row1_base_24).toBe(10000);
      expect(d.row6_intra_eu_acquisition).toBe(10000);
      expect(d.row4_output_vat).toBe(2400);
      expect(d.row5_input_vat).toBe(1200);

      // The official artifact must say the same thing the JSON does — this is
      // what is actually filed.
      const periods = (
        await http().get('/api/reporting-periods').set(auth()).expect(200)
      ).body as { reportingPeriods: { id: number; name: string }[] };
      const periodId = periods.reportingPeriods.find(
        (p) => p.name === PERIOD.name,
      )!.id;
      const xml = (
        await http()
          .get(`/api/reporting-periods/${periodId}/statutory-report?format=xml`)
          .set(auth())
          .expect(200)
      ).text;

      expect(xml).toContain('<transactions24>100.00</transactions24>');
      expect(xml).toContain(
        '<euAcquisitionsGoodsAndServicesTotal>100.00</euAcquisitionsGoodsAndServicesTotal>',
      );
      // Only the deductible half reaches row 5 — the irrecoverable half is in
      // the cost, not on the return.
      expect(xml).toContain('<inputVatTotal>12.00</inputVatTotal>');
      expect(validateAgainstKmdXsd(xml, xsd)).toEqual({
        valid: true,
        errors: [],
      });
    });
  });

  // ── The guard, through the REAL pipeline ─────────────────────────────────

  describe('a prepared draft overtaken by a settings change', () => {
    it('refuses the expense post when the entitlement moved between draft and transaction', async () => {
      const id = await createExpense({
        category: 'software',
        gross_amount: 12400,
        vat_amount: 2400,
      });

      // Controlled pause: the settings change lands between draft generation
      // and the posting transaction — the interleaving the guard exists for.
      const expenses = app.get(ExpensesService);
      const original = expenses.generateDraftVoucher.bind(expenses);
      const spy = jest
        .spyOn(expenses, 'generateDraftVoucher')
        .mockImplementation(async (expenseId: number) => {
          const draft = await original(expenseId);
          if (expenseId === id) {
            await putOrg({
              input_vat_entitlement: 'partial',
              input_vat_deduction_permille: 500,
            }).expect(200);
          }
          return draft;
        });

      const refusal = await postExpense(id).expect(409);
      spy.mockRestore();
      expect((refusal.body as { message: string }).message).toMatch(
        /input-VAT deduction/,
      );

      // Nothing posted, nothing held.
      const expense = await db
        .selectFrom('expense')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(expense).toMatchObject({ status: 'draft', voucher_id: null });
      expect(await db.selectFrom('voucher').selectAll().execute()).toHaveLength(
        0,
      );
      expect(
        await db.selectFrom('approval').selectAll().execute(),
      ).toHaveLength(0);
      expect((await declaration()).row5_input_vat).toBe(0);
    });

    it('refuses the sale post when OUR registration moved between draft and transaction', async () => {
      const customer = (
        await http()
          .post('/api/entities')
          .set(auth())
          .send({
            role: 'customer',
            country: 'EE',
            name: 'Domestic OÜ',
            registrationKey: 'EE900000002',
            goodsVsServices: 'services',
            taxStatus: 'taxable_business',
          })
          .expect(201)
      ).body as { id: number };
      const invoice = (
        await http()
          .post('/api/sales-invoices')
          .set(auth())
          .send({
            customer_id: customer.id,
            invoice_number: 'INV-211-RACE',
            gross_amount: 12400,
            vat_amount: 2400,
            currency: 'EUR',
            tax_point_date: TAX_POINT,
          })
          .expect(201)
      ).body as { id: number };

      const invoices = app.get(SalesInvoicesService);
      const original = invoices.generateDraftVoucher.bind(invoices);
      const spy = jest
        .spyOn(invoices, 'generateDraftVoucher')
        .mockImplementation(async (invoiceId: number) => {
          const draft = await original(invoiceId);
          if (invoiceId === invoice.id) {
            // Deregistering, rather than switching to a limited registration:
            // the limited kind is caught EARLIER, by the classifier refusing to
            // place the supply at all (asserted separately below). This change
            // classifies the same way, so it reaches — and proves — the
            // draft-facts guard inside the posting transaction.
            await putOrg({ vat_registered: false }).expect(200);
          }
          return draft;
        });

      const refusal = await http()
        .post(`/api/sales-invoices/${invoice.id}/post`)
        .set(auth())
        .send({})
        .expect(409);
      spy.mockRestore();
      expect((refusal.body as { message: string }).message).toMatch(
        /organisation's VAT registration/,
      );

      const after = await db
        .selectFrom('sales_invoice')
        .selectAll()
        .where('id', '=', invoice.id)
        .executeTakeFirstOrThrow();
      expect(after).toMatchObject({ status: 'draft', voucher_id: null });
      expect(await db.selectFrom('voucher').selectAll().execute()).toHaveLength(
        0,
      );
      expect(
        await db.selectFrom('approval').selectAll().execute(),
      ).toHaveLength(0);
    });
  });

  // ── KMD INF part B: a report about the INVOICE, not about our cost ───────

  describe('KMD INF part B and non-deductible input VAT', () => {
    const seller = () =>
      addSupplier({
        country: 'EE',
        name: 'Domestic Seller OÜ',
        registrationKey: 'EE101010101',
        goodsVsServices: 'services',
        taxStatus: 'taxable_business',
      });

    /** The part-B rows of the live draft KMD XML. */
    async function partBRows(): Promise<string[]> {
      const periods = (
        await http().get('/api/reporting-periods').set(auth()).expect(200)
      ).body as { reportingPeriods: { id: number; name: string }[] };
      const periodId = periods.reportingPeriods.find(
        (p) => p.name === PERIOD.name,
      )!.id;
      const xml = (
        await http()
          .get(`/api/reporting-periods/${periodId}/statutory-report?format=xml`)
          .set(auth())
          .expect(200)
      ).text;
      expect(validateAgainstKmdXsd(xml, xsd)).toEqual({
        valid: true,
        errors: [],
      });
      return xml
        .split('<purchaseLine>')
        .slice(1)
        .map((chunk) => chunk.split('</purchaseLine>')[0]);
    }

    it('excludes a qualifying invoice whose VAT was not deducted at all', async () => {
      await putOrg({ vat_registered: false }).expect(200);
      const supplier = await seller();

      // €1000 net + €240 VAT — comfortably over the threshold on its face.
      const id = await createExpense({
        category: 'software',
        gross_amount: 124000,
        vat_amount: 24000,
        supplier_id: supplier,
        supplier_invoice_number: 'S-1',
      });
      await postAndSettle(id);

      // Part B reports invoices whose input VAT was DEDUCTED. None was.
      expect(await partBRows()).toHaveLength(0);
      expect((await declaration()).row5_input_vat).toBe(0);
    });

    it('does not let irrecoverable VAT in the cost push a partner over the €1000 threshold', async () => {
      await putOrg({
        input_vat_entitlement: 'partial',
        input_vat_deduction_permille: 500,
      }).expect(200);
      const supplier = await seller();

      // €900 net + €216 VAT. The invoice is BELOW the threshold, which is
      // measured without VAT — but the cost booked is 900 + 108 = €1008, and
      // reading the threshold off the cost would wrongly report it.
      const id = await createExpense({
        category: 'software',
        gross_amount: 111600,
        vat_amount: 21600,
        supplier_id: supplier,
        supplier_invoice_number: 'S-2',
      });
      await postAndSettle(id);

      expect(await partBRows()).toHaveLength(0);
      // The deduction itself is unaffected — this is only about INF.
      expect((await declaration()).row5_input_vat).toBe(10800);
    });

    it('reports a qualifying partial invoice at its own value, with only the deducted VAT in the period', async () => {
      await putOrg({
        input_vat_entitlement: 'partial',
        input_vat_deduction_permille: 500,
      }).expect(200);
      const supplier = await seller();

      // €1000 net + €240 VAT, half deductible.
      const id = await createExpense({
        category: 'software',
        gross_amount: 124000,
        vat_amount: 24000,
        supplier_id: supplier,
        supplier_invoice_number: 'S-3',
      });
      await postAndSettle(id);

      const rows = await partBRows();
      expect(rows).toHaveLength(1);
      // The INVOICE's total, not our cost of 1120…
      expect(rows[0]).toContain('<invoiceSumVat>1240.00</invoiceSumVat>');
      // …and only what we actually deducted.
      expect(rows[0]).toContain('<vatInPeriod>120.00</vatInPeriod>');
      expect((await declaration()).row5_input_vat).toBe(12000);
    });

    it('reads the invoice in base currency at the rate the voucher was posted at', async () => {
      // The trap this covers: comparing a BASE-currency ledger figure with a
      // DOCUMENT-currency one to decide whether anything diverged. At 50%
      // entitlement and a rate of 2 the two coincide numerically, so the
      // document figures would be skipped and the threshold read off the cost.
      await putOrg({
        input_vat_entitlement: 'partial',
        input_vat_deduction_permille: 500,
      }).expect(200);
      const supplier = await seller();

      // USD 450 net + USD 108 VAT. The fixture publishes USD at 2.0 per EUR on
      // the tax point, so in base currency that is 900 net + 216 tax — an
      // invoice BELOW the €1000 threshold, whose cost is 900 + 108 = 1008.
      const id = await createExpense({
        category: 'software',
        gross_amount: 55800,
        vat_amount: 10800,
        currency: 'USD',
        supplier_id: supplier,
        supplier_invoice_number: 'S-FX',
      });
      await postAndSettle(id);

      expect(await partBRows()).toHaveLength(0);
    });

    it('reports a fully deducted invoice exactly as it always did', async () => {
      const supplier = await seller();
      const id = await createExpense({
        category: 'software',
        gross_amount: 124000,
        vat_amount: 24000,
        supplier_id: supplier,
        supplier_invoice_number: 'S-4',
      });
      await postAndSettle(id);

      const rows = await partBRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toContain('<invoiceSumVat>1240.00</invoiceSumVat>');
      expect(rows[0]).toContain('<vatInPeriod>240.00</vatInPeriod>');
      expect((await declaration()).row5_input_vat).toBe(24000);
    });
  });

  describe('a sale under a LIMITED registration', () => {
    it('is refused rather than classified as an ordinary taxable supply', async () => {
      const customer = (
        await http()
          .post('/api/entities')
          .set(auth())
          .send({
            role: 'customer',
            country: 'EE',
            name: 'Domestic OÜ',
            registrationKey: 'EE900000001',
            goodsVsServices: 'services',
            taxStatus: 'taxable_business',
          })
          .expect(201)
      ).body as { id: number };

      const invoice = (
        await http()
          .post('/api/sales-invoices')
          .set(auth())
          .send({
            customer_id: customer.id,
            invoice_number: 'INV-211-1',
            gross_amount: 12400,
            vat_amount: 2400,
            currency: 'EUR',
            tax_point_date: TAX_POINT,
          })
          .expect(201)
      ).body as { id: number };

      await putOrg({ vat_registration_kind: 'limited' }).expect(200);

      const res = await http()
        .post(`/api/sales-invoices/${invoice.id}/post`)
        .set(auth())
        .send({});
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).toMatch(
        /limited_registration_sale_unsupported/,
      );

      // Nothing was posted: no voucher exists for it.
      const vouchers = await db.selectFrom('voucher').selectAll().execute();
      expect(vouchers).toHaveLength(0);
    });
  });
});
