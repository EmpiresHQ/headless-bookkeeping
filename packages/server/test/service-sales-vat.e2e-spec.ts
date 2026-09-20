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
import { SalesInvoicesService } from '../src/sales-invoices/sales-invoices.service';
import request from 'supertest';
import { App } from 'supertest/types';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

/**
 * Service sales VAT — the place-of-supply decision end to end (issue #209).
 *
 * Everything here goes through real HTTP against a real (in-memory) database:
 * the customer's facts are onboarded over the API, the invoice is created and
 * posted over the API, and the figures are read back from the KMD declaration
 * and the official KMD XML. That is the only way to show what the bug report
 * showed — that a US business's service invoice reached `<transactions24>`.
 *
 * The four general-rule cases (EE domestic, EU B2B, EU B2C, non-EU B2B) each
 * assert the whole chain agrees: the ledger VAT code, the invoice's tax amount,
 * the KMD rows and the exported XML.
 */
describe('Service sales VAT classification (E2E)', () => {
  let app: INestApplication<App>;
  let db: Kysely<Database>;
  let root: string;
  let token: string;

  // One month, well inside the 24% era, used by every case below.
  const TAX_POINT = '2026-05-15';
  const PERIOD = { name: '2026-05', start: '2026-05-01', end: '2026-05-31' };

  const auth = () => ({ Authorization: `Bearer ${token}` });

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

    // These cases are about WHAT gets posted, not about the approval gate:
    // enable auto-post so a correctly-classified invoice reaches the ledger in
    // one call. The kill switch's own default is covered elsewhere.
    await db
      .insertInto('policy_config')
      .values({ key: 'auto_post_enabled', value: 'true', updated_at: 0 })
      .execute();

    root = mkdtempSync(join(tmpdir(), 'service-sales-vat-e2e-'));

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
      .useValue(new FixtureFxRateSource(ECB_FIXTURE_RATES))
      .compile();

    app = module.createNestApplication();
    await app.init();

    token = 'test-token-service-vat-12345';
    await db
      .insertInto('api_token')
      .values({
        token_hash: createHash('sha256').update(token).digest('hex'),
        label: 'e2e-service-vat',
      })
      .execute();

    // An EE organization with a declarant identity, and an open period the
    // invoices below fall into.
    await request(app.getHttpServer())
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
    await request(app.getHttpServer())
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

  // ── API helpers (all real HTTP) ──────────────────────────────────────────

  interface CustomerFacts {
    country: string;
    name: string;
    registrationKey: string;
    goodsVsServices?: 'goods' | 'services' | 'unknown';
    taxStatus?: 'taxable_business' | 'non_taxable' | 'unknown';
  }

  async function addCustomer(facts: CustomerFacts): Promise<number> {
    const res = await request(app.getHttpServer())
      .post('/api/entities')
      .set(auth())
      .send({ role: 'customer', ...facts })
      .expect(201);
    return (res.body as { id: number }).id;
  }

  async function createInvoice(body: Record<string, unknown>): Promise<number> {
    const res = await request(app.getHttpServer())
      .post('/api/sales-invoices')
      .set(auth())
      .send({ currency: 'EUR', tax_point_date: TAX_POINT, ...body })
      .expect(201);
    return (res.body as { id: number }).id;
  }

  const postInvoice = (id: number) =>
    request(app.getHttpServer())
      .post(`/api/sales-invoices/${id}/post`)
      .set(auth())
      .send({});

  async function periodId(): Promise<number> {
    const res = await request(app.getHttpServer())
      .get('/api/reporting-periods')
      .set(auth())
      .expect(200);
    const { reportingPeriods } = res.body as {
      reportingPeriods: { id: number; name: string }[];
    };
    const found = reportingPeriods.find((p) => p.name === PERIOD.name);
    if (!found) throw new Error('period not found');
    return found.id;
  }

  async function declaration(): Promise<KmdDeclaration> {
    const res = await request(app.getHttpServer())
      .get(`/api/reporting-periods/${await periodId()}/kmd`)
      .set(auth())
      .expect(200);
    return res.body as KmdDeclaration;
  }

  async function kmdXml(): Promise<string> {
    const res = await request(app.getHttpServer())
      .get(
        `/api/reporting-periods/${await periodId()}/statutory-report?format=xml`,
      )
      .set(auth())
      .expect(200);
    return res.text;
  }

  /** The VAT code(s) the posted invoice's revenue leg carries in the ledger. */
  async function revenueVatCodes(invoiceId: number): Promise<string[]> {
    const rows = await db
      .selectFrom('sales_invoice as si')
      .innerJoin('voucher_line as vl', 'vl.voucher_id', 'si.voucher_id')
      .innerJoin('account as a', 'a.id', 'vl.account_id')
      .select(['vl.vat_code'])
      .where('si.id', '=', invoiceId)
      .where('a.code', '=', 'REVENUE')
      .execute();
    return rows.map((r) => r.vat_code ?? '');
  }

  // ── The general-rule matrix, end to end ─────────────────────────────────

  it('EE domestic business services → 24%: KMD rows 1 + 4, XML transactions24', async () => {
    const customer = await addCustomer({
      country: 'EE',
      name: 'Kodumaine OÜ',
      registrationKey: 'EE200000002',
      goodsVsServices: 'services',
      taxStatus: 'taxable_business',
    });
    const id = await createInvoice({
      customer_id: customer,
      invoice_number: 'INV-EE-1',
      gross_amount: 12400,
      vat_amount: 2400,
      supply_type: 'services',
    });
    await postInvoice(id).expect(201);

    expect(await revenueVatCodes(id)).toEqual(['EE_OUTPUT_24']);
    const d = await declaration();
    expect(d.row1_base_24).toBe(10000);
    expect(d.row4_output_vat).toBe(2400);
    expect(d.row3_base_zero).toBe(0);
    expect(d.row3_1_intra_eu_supply).toBe(0);

    const xml = await kmdXml();
    expect(xml).toContain('<transactions24>100.00</transactions24>');
    expect(xml).not.toContain('transactionsZeroVat');
  });

  it('EU B2B services → 0%: KMD rows 3 AND 3.1 + VD 3S, XML euSupply… field', async () => {
    const customer = await addCustomer({
      country: 'FI',
      name: 'Suomi Oy',
      registrationKey: 'FI12345678',
      goodsVsServices: 'services',
      taxStatus: 'taxable_business',
    });
    const id = await createInvoice({
      customer_id: customer,
      invoice_number: 'INV-FI-B2B',
      gross_amount: 10000,
      vat_amount: 0,
      supply_type: 'services',
    });
    await postInvoice(id).expect(201);

    expect(await revenueVatCodes(id)).toEqual(['EE_OUTPUT_0_EU']);
    const d = await declaration();
    expect(d.row3_base_zero).toBe(10000);
    // Field 3.1 — the part of row 3 supplied to a taxable person of another
    // member state. The EMTA form requires 3 AND 3.1 for this case.
    expect(d.row3_1_intra_eu_supply).toBe(10000);
    expect(d.vd_intra_eu_services).toBe(10000);
    expect(d.row1_base_24).toBe(0);
    expect(d.row4_output_vat).toBe(0);
    expect(d.review_flags.join(' ')).toMatch(/VD koondaruanne/);

    const xml = await kmdXml();
    expect(xml).toContain('<transactionsZeroVat>100.00</transactionsZeroVat>');
    expect(xml).toContain(
      '<euSupplyInclGoodsAndServicesZeroVat>100.00</euSupplyInclGoodsAndServicesZeroVat>',
    );
    expect(xml).not.toContain('transactions24');
  });

  it('EU B2C services → 24%, NOT inferred to be intra-EU B2B from the country', async () => {
    const customer = await addCustomer({
      country: 'FI',
      name: 'Matti Meikäläinen',
      registrationKey: 'FI87654321',
      goodsVsServices: 'services',
      taxStatus: 'non_taxable',
    });
    const id = await createInvoice({
      customer_id: customer,
      invoice_number: 'INV-FI-B2C',
      gross_amount: 12400,
      vat_amount: 2400,
      supply_type: 'services',
    });
    await postInvoice(id).expect(201);

    expect(await revenueVatCodes(id)).toEqual(['EE_OUTPUT_24']);
    const d = await declaration();
    expect(d.row1_base_24).toBe(10000);
    expect(d.row4_output_vat).toBe(2400);
    expect(d.row3_base_zero).toBe(0);
    expect(d.row3_1_intra_eu_supply).toBe(0);
    expect(d.vd_intra_eu_services).toBe(0);

    const xml = await kmdXml();
    expect(xml).toContain('<transactions24>100.00</transactions24>');
    expect(xml).not.toContain('euSupplyInclGoodsAndServicesZeroVat');
  });

  it('non-EU B2B services → 0% in row 3 only — the reported misclassification', async () => {
    // The bug report's reproduction, verbatim: a US business customer, a
    // EUR 100 general-rule service invoice with vat_amount 0. Before the fix
    // this produced row1_base_24 = 10000 and <transactions24>100.00</…>.
    const customer = await addCustomer({
      country: 'US',
      name: 'Stateside Inc',
      registrationKey: 'US99-1234567',
      goodsVsServices: 'services',
      taxStatus: 'taxable_business',
    });
    const id = await createInvoice({
      customer_id: customer,
      invoice_number: 'INV-US-B2B',
      gross_amount: 10000,
      vat_amount: 0,
      supply_type: 'services',
    });
    await postInvoice(id).expect(201);

    // The reported symptoms first, so a regression names the defect rather
    // than an internal code: KMD row 1 and <transactions24> must be empty.
    const d = await declaration();
    expect(d.row1_base_24).toBe(0);
    expect(d.row4_output_vat).toBe(0);
    expect(await revenueVatCodes(id)).toEqual(['EE_OUTPUT_0_3RD_COUNTRY']);
    expect(d.row3_base_zero).toBe(10000);
    // A third country is not a member state: no field 3.1, no VD entry.
    expect(d.row3_1_intra_eu_supply).toBe(0);
    expect(d.vd_intra_eu_services).toBe(0);
    expect(d.review_flags.join(' ')).not.toMatch(/VD koondaruanne/);

    const xml = await kmdXml();
    expect(xml).toContain('<transactionsZeroVat>100.00</transactionsZeroVat>');
    expect(xml).not.toContain('transactions24');
    expect(xml).not.toContain('euSupplyInclGoodsAndServicesZeroVat');
  });

  // ── Refusals: nothing is posted on facts we do not have ─────────────────

  it('REFUSES an EU service sale while the tax status is unknown, then posts once it is supplied', async () => {
    const customer = await addCustomer({
      country: 'FI',
      name: 'Tuntematon Oy',
      registrationKey: 'FI11112222',
      goodsVsServices: 'services',
      // taxStatus deliberately not supplied — this is the pre-#209 state of
      // every customer, and it must not resolve to "consumer".
    });
    const id = await createInvoice({
      customer_id: customer,
      invoice_number: 'INV-FI-UNKNOWN',
      gross_amount: 10000,
      vat_amount: 0,
      supply_type: 'services',
    });

    const refusal = await postInvoice(id).expect(422);
    const body = refusal.body as {
      code: string;
      missing_facts: string[];
      how_to_resolve: string;
    };
    expect(body.code).toBe('customer_tax_status_unknown');
    expect(body.how_to_resolve).toContain('PATCH /api/entities');

    // Nothing was posted: the invoice is still a draft with no voucher, and
    // the period's declaration is empty.
    const after = await request(app.getHttpServer())
      .get(`/api/sales-invoices`)
      .set(auth())
      .expect(200);
    const invoice = (
      after.body as {
        invoices: { id: number; status: string; voucher_id: number | null }[];
      }
    ).invoices.find((i) => i.id === id)!;
    expect(invoice.status).toBe('draft');
    expect(invoice.voucher_id).toBeNull();
    const empty = await declaration();
    expect(empty.row1_base_24).toBe(0);
    expect(empty.row3_base_zero).toBe(0);

    // The named remedy is the whole remedy.
    await request(app.getHttpServer())
      .patch(`/api/entities/${customer}`)
      .set(auth())
      .send({ taxStatus: 'taxable_business' })
      .expect(200);
    await postInvoice(id).expect(201);
    expect(await revenueVatCodes(id)).toEqual(['EE_OUTPUT_0_EU']);
    expect((await declaration()).row3_1_intra_eu_supply).toBe(10000);
  });

  it('REFUSES a declared special place-of-supply rule instead of blanket-treating it', async () => {
    const customer = await addCustomer({
      country: 'FI',
      name: 'Kiinteistö Oy',
      registrationKey: 'FI33334444',
      goodsVsServices: 'services',
      taxStatus: 'taxable_business',
    });
    const id = await createInvoice({
      customer_id: customer,
      invoice_number: 'INV-FI-PROPERTY',
      gross_amount: 10000,
      vat_amount: 0,
      supply_type: 'services',
      service_place_rule: 'immovable_property',
    });
    const refusal = await postInvoice(id).expect(422);
    expect((refusal.body as { code: string }).code).toBe(
      'service_place_rule_unsupported',
    );
    expect((await declaration()).row3_base_zero).toBe(0);
  });

  it('REFUSES a declared service rule on a supply that is not a service', async () => {
    const customer = await addCustomer({
      country: 'FI',
      name: 'Tavara Oy',
      registrationKey: 'FI55556666',
      goodsVsServices: 'goods',
      taxStatus: 'taxable_business',
    });
    const id = await createInvoice({
      customer_id: customer,
      invoice_number: 'INV-FI-RULE-ON-GOODS',
      gross_amount: 12400,
      vat_amount: 2400,
      supply_type: 'goods',
      service_place_rule: 'restaurant_catering',
    });
    const refusal = await postInvoice(id).expect(422);
    expect((refusal.body as { code: string }).code).toBe(
      'service_place_rule_without_service_supply',
    );
  });

  it('REFUSES a cross-border sale whose supply type nobody recorded', async () => {
    const customer = await addCustomer({
      country: 'FI',
      name: 'Epäselvä Oy',
      registrationKey: 'FI77778888',
      goodsVsServices: 'unknown',
      taxStatus: 'taxable_business',
    });
    const id = await createInvoice({
      customer_id: customer,
      invoice_number: 'INV-FI-NO-TYPE',
      gross_amount: 12400,
      vat_amount: 2400,
    });
    const refusal = await postInvoice(id).expect(422);
    expect((refusal.body as { code: string }).code).toBe('supply_type_unknown');
    expect((await declaration()).row1_base_24).toBe(0);
  });

  it('REFUSES a caller VAT amount that contradicts the resolved treatment', async () => {
    const customer = await addCustomer({
      country: 'FI',
      name: 'Väärä Summa Oy',
      registrationKey: 'FI99990000',
      goodsVsServices: 'services',
      taxStatus: 'taxable_business',
    });
    // 0%-rated intra-EU service, invoiced with 24% of VAT anyway.
    const id = await createInvoice({
      customer_id: customer,
      invoice_number: 'INV-FI-BAD-VAT',
      gross_amount: 12400,
      vat_amount: 2400,
      supply_type: 'services',
    });
    const refusal = await postInvoice(id).expect(422);
    expect((refusal.body as { code: string }).code).toBe(
      'vat_amount_conflicts_with_treatment',
    );
    // Refused BEFORE any posting — no half-written voucher, empty declaration.
    const d = await declaration();
    expect(d.row1_base_24).toBe(0);
    expect(d.row3_base_zero).toBe(0);
    expect(d.row4_output_vat).toBe(0);
  });

  // ── Correcting the SAME draft is a supported call ────────────────────────

  it('a wrongly declared exception is corrected on the same draft, then posts', async () => {
    // The invoice number is unique, so "create it again" is no remedy: the
    // refusal has to be fixable on the draft that was refused.
    const customer = await addCustomer({
      country: 'FI',
      name: 'Korjaus Oy',
      registrationKey: 'FI10101010',
      goodsVsServices: 'services',
      taxStatus: 'taxable_business',
    });
    const id = await createInvoice({
      customer_id: customer,
      invoice_number: 'INV-FI-FIXME',
      gross_amount: 10000,
      vat_amount: 0,
      supply_type: 'services',
      service_place_rule: 'other_special',
    });
    expect((await postInvoice(id).expect(422)).body).toMatchObject({
      code: 'service_place_rule_unsupported',
    });

    // Re-creating it under the same number is refused, which is why PATCH exists.
    await request(app.getHttpServer())
      .post('/api/sales-invoices')
      .set(auth())
      .send({
        customer_id: customer,
        invoice_number: 'INV-FI-FIXME',
        gross_amount: 10000,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: TAX_POINT,
      })
      .expect(409);

    const patched = await request(app.getHttpServer())
      .patch(`/api/sales-invoices/${id}`)
      .set(auth())
      .send({ service_place_rule: 'general' })
      .expect(200);
    expect(patched.body).toMatchObject({
      service_place_rule: 'general',
      supply_type: 'services',
      status: 'draft',
    });

    await postInvoice(id).expect(201);
    expect(await revenueVatCodes(id)).toEqual(['EE_OUTPUT_0_EU']);
  });

  it('a contradicting VAT amount is corrected on the same draft, then posts', async () => {
    const customer = await addCustomer({
      country: 'US',
      name: 'Fix Amount Inc',
      registrationKey: 'US88-8888888',
      goodsVsServices: 'services',
      taxStatus: 'taxable_business',
    });
    const id = await createInvoice({
      customer_id: customer,
      invoice_number: 'INV-US-FIX-VAT',
      gross_amount: 12400,
      vat_amount: 2400,
      supply_type: 'services',
    });
    expect((await postInvoice(id).expect(422)).body).toMatchObject({
      code: 'vat_amount_conflicts_with_treatment',
    });

    await request(app.getHttpServer())
      .patch(`/api/sales-invoices/${id}`)
      .set(auth())
      .send({ gross_amount: 10000, vat_amount: 0 })
      .expect(200);
    await postInvoice(id).expect(201);

    expect(await revenueVatCodes(id)).toEqual(['EE_OUTPUT_0_3RD_COUNTRY']);
    expect((await declaration()).row3_base_zero).toBe(10000);
  });

  it('a missing supply type is supplied on the same draft, then posts', async () => {
    const customer = await addCustomer({
      country: 'FI',
      name: 'Tyyppi Oy',
      registrationKey: 'FI20202020',
      goodsVsServices: 'unknown',
      taxStatus: 'taxable_business',
    });
    const id = await createInvoice({
      customer_id: customer,
      invoice_number: 'INV-FI-ADD-TYPE',
      gross_amount: 10000,
      vat_amount: 0,
    });
    expect((await postInvoice(id).expect(422)).body).toMatchObject({
      code: 'supply_type_unknown',
    });

    await request(app.getHttpServer())
      .patch(`/api/sales-invoices/${id}`)
      .set(auth())
      .send({ supply_type: 'services' })
      .expect(200);
    await postInvoice(id).expect(201);
    expect(await revenueVatCodes(id)).toEqual(['EE_OUTPUT_0_EU']);
  });

  it('REFUSES to patch a POSTED invoice — its voucher is immutable', async () => {
    const customer = await addCustomer({
      country: 'EE',
      name: 'Postitatud OÜ',
      registrationKey: 'EE400000004',
      goodsVsServices: 'services',
      taxStatus: 'taxable_business',
    });
    const id = await createInvoice({
      customer_id: customer,
      invoice_number: 'INV-EE-POSTED',
      gross_amount: 12400,
      vat_amount: 2400,
      supply_type: 'services',
    });
    await postInvoice(id).expect(201);
    const before = await db
      .selectFrom('sales_invoice')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

    const refusal = await request(app.getHttpServer())
      .patch(`/api/sales-invoices/${id}`)
      .set(auth())
      .send({ supply_type: 'goods', vat_amount: 0 })
      .expect(409);
    expect((refusal.body as { message: string }).message).toContain(
      'is posted',
    );

    // The posted object and its voucher are untouched.
    expect(
      await db
        .selectFrom('sales_invoice')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
    expect(await revenueVatCodes(id)).toEqual(['EE_OUTPUT_24']);
    expect((await declaration()).row1_base_24).toBe(10000);
  });

  it('a PENDING invoice: PATCH supersedes the held approval, and the new facts are what posts', async () => {
    // Over the auto-post ceiling (100000 minor units), so Policy HOLDS it and a
    // real approval exists to be superseded.
    const customer = await addCustomer({
      country: 'FI',
      name: 'Suuri Oy',
      registrationKey: 'FI30303030',
      goodsVsServices: 'services',
      taxStatus: 'taxable_business',
    });
    const id = await createInvoice({
      customer_id: customer,
      invoice_number: 'INV-FI-HELD',
      gross_amount: 500000,
      vat_amount: 0,
      supply_type: 'services',
    });
    const held = await postInvoice(id).expect(201);
    expect(held.body).toMatchObject({
      policy: { action: 'hold-for-approval' },
      invoice: { status: 'pending' },
    });
    const approvals = await request(app.getHttpServer())
      .get('/api/approvals/pending')
      .set(auth())
      .expect(200);
    const approval = (
      approvals.body as {
        approvals: { id: number; object_type: string; object_id: number }[];
      }
    ).approvals.find(
      (a) => a.object_type === 'sales_invoice' && a.object_id === id,
    )!;
    expect(approval).toBeDefined();

    // The operator corrects the supply facts while it is held.
    const patched = await request(app.getHttpServer())
      .patch(`/api/sales-invoices/${id}`)
      .set(auth())
      .send({ gross_amount: 400000, vat_amount: 0 })
      .expect(200);
    expect(patched.body).toMatchObject({
      status: 'draft',
      gross_amount: 400000,
      voucher_id: null,
    });

    // The held approval no longer approves anything — it was superseded, so the
    // figures a human saw can never be posted behind the edit's back.
    const staleApproval = await request(app.getHttpServer())
      .post(`/api/approvals/${approval.id}/approve`)
      .set(auth())
      .send({ approved_by: 'operator' })
      .expect(409);
    expect((staleApproval.body as { message: string }).message).toMatch(
      /superseded/,
    );

    // Posting again holds afresh; approving THAT posts the corrected figures.
    const reheld = await postInvoice(id).expect(201);
    expect(reheld.body).toMatchObject({
      policy: { action: 'hold-for-approval' },
    });
    const fresh = await request(app.getHttpServer())
      .get('/api/approvals/pending')
      .set(auth())
      .expect(200);
    const newApproval = (
      fresh.body as {
        approvals: { id: number; object_type: string; object_id: number }[];
      }
    ).approvals.find(
      (a) => a.object_type === 'sales_invoice' && a.object_id === id,
    )!;
    expect(newApproval.id).not.toBe(approval.id);
    await request(app.getHttpServer())
      .post(`/api/approvals/${newApproval.id}/approve`)
      .set(auth())
      .send({ approved_by: 'operator' })
      .expect(201);

    expect(await revenueVatCodes(id)).toEqual(['EE_OUTPUT_0_EU']);
    const d = await declaration();
    expect(d.row3_base_zero).toBe(400000);
    expect(d.row3_1_intra_eu_supply).toBe(400000);
  });

  // ── The reverse order: an edit that lands AFTER the draft was prepared ───

  it('refuses a post whose prepared entry was overtaken by a PATCH, then posts the NEW facts', async () => {
    // The status claim cannot see this one: correcting a draft leaves it a
    // draft, so without the facts guard the pipeline would post the voucher it
    // derived BEFORE the edit and attach it to the edited invoice.
    const customer = await addCustomer({
      country: 'FI',
      name: 'Kilpajuoksu Oy',
      registrationKey: 'FI40404040',
      goodsVsServices: 'services',
      taxStatus: 'taxable_business',
    });
    const id = await createInvoice({
      customer_id: customer,
      invoice_number: 'INV-FI-RACE',
      gross_amount: 10000,
      vat_amount: 0,
      supply_type: 'services',
    });

    // Controlled pause: the PATCH lands between draft generation and the
    // posting transaction — the exact interleaving under test.
    const service = app.get(SalesInvoicesService);
    const original = service.generateDraftVoucher.bind(service);
    const spy = jest
      .spyOn(service, 'generateDraftVoucher')
      .mockImplementation(async (invoiceId: number) => {
        const draft = await original(invoiceId);
        if (invoiceId === id) {
          await request(app.getHttpServer())
            .patch(`/api/sales-invoices/${id}`)
            .set(auth())
            .send({ gross_amount: 80000 })
            .expect(200);
        }
        return draft;
      });

    const refusal = await postInvoice(id).expect(409);
    spy.mockRestore();
    expect((refusal.body as { message: string }).message).toMatch(
      /changed while it was being posted/,
    );

    // Nothing was posted or held: still a draft, no voucher, empty declaration.
    const afterRefusal = await db
      .selectFrom('sales_invoice')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(afterRefusal).toMatchObject({
      status: 'draft',
      voucher_id: null,
      gross_amount: 80000,
    });
    const empty = await declaration();
    expect(empty.row3_base_zero).toBe(0);
    expect(empty.row1_base_24).toBe(0);
    expect(await db.selectFrom('voucher').selectAll().execute()).toHaveLength(
      0,
    );

    // Posting again recomputes everything from the current facts — and the
    // recomputed entry carries the PATCHed amount, not the prepared one.
    await postInvoice(id).expect(201);
    expect(await revenueVatCodes(id)).toEqual(['EE_OUTPUT_0_EU']);
    const d = await declaration();
    expect(d.row3_base_zero).toBe(80000);
    expect(d.row3_1_intra_eu_supply).toBe(80000);
  });

  it('refuses a HOLD whose prepared entry was overtaken by a PATCH', async () => {
    // Over the ceiling, so the pipeline would create an approval: a human must
    // never be asked to approve figures that were already edited away.
    const customer = await addCustomer({
      country: 'EE',
      name: 'Suur Kodumaine OÜ',
      registrationKey: 'EE500000005',
      goodsVsServices: 'services',
      taxStatus: 'taxable_business',
    });
    const id = await createInvoice({
      customer_id: customer,
      invoice_number: 'INV-EE-RACE-HOLD',
      gross_amount: 620000,
      vat_amount: 120000,
      supply_type: 'services',
    });

    const service = app.get(SalesInvoicesService);
    const original = service.generateDraftVoucher.bind(service);
    const spy = jest
      .spyOn(service, 'generateDraftVoucher')
      .mockImplementation(async (invoiceId: number) => {
        const draft = await original(invoiceId);
        if (invoiceId === id) {
          await request(app.getHttpServer())
            .patch(`/api/sales-invoices/${id}`)
            .set(auth())
            .send({ gross_amount: 248000, vat_amount: 48000 })
            .expect(200);
        }
        return draft;
      });

    await postInvoice(id).expect(409);
    spy.mockRestore();

    // No approval was created against the stale figures.
    expect(
      await db
        .selectFrom('approval')
        .selectAll()
        .where('object_type', '=', 'sales_invoice')
        .where('object_id', '=', id)
        .execute(),
    ).toHaveLength(0);
    const still = await db
      .selectFrom('sales_invoice')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(still).toMatchObject({ status: 'draft', gross_amount: 248000 });
  });

  // ── Facts persist, and history is measured by the invoice's own date ─────

  it('persists the invoice supply facts through HTTP', async () => {
    const id = await createInvoice({
      invoice_number: 'INV-FACTS-HTTP',
      gross_amount: 10000,
      vat_amount: 2400,
      supply_type: 'services',
      service_place_rule: 'general',
    });
    const res = await request(app.getHttpServer())
      .get('/api/sales-invoices')
      .set(auth())
      .expect(200);
    const row = (
      res.body as {
        invoices: {
          id: number;
          supply_type: string | null;
          service_place_rule: string;
        }[];
      }
    ).invoices.find((i) => i.id === id)!;
    expect(row.supply_type).toBe('services');
    expect(row.service_place_rule).toBe('general');
  });

  it('measures a back-dated service invoice against the rate of ITS tax point', async () => {
    // 2025-06 was the 22% era; 24% only took effect on 2025-07-01. A correct
    // 22% invoice must post, and a 24% one for the same date must not.
    await request(app.getHttpServer())
      .post('/api/reporting-periods')
      .set(auth())
      .send({
        name: '2025-06',
        start_date: '2025-06-01',
        end_date: '2025-06-30',
      })
      .expect(201);

    const customer = await addCustomer({
      country: 'EE',
      name: 'Ajalugu OÜ',
      registrationKey: 'EE300000003',
      goodsVsServices: 'services',
      taxStatus: 'taxable_business',
    });

    const historic = await createInvoice({
      customer_id: customer,
      invoice_number: 'INV-EE-2025-06',
      gross_amount: 12200,
      vat_amount: 2200,
      tax_point_date: '2025-06-15',
      supply_type: 'services',
    });
    await postInvoice(historic).expect(201);

    const wrongRate = await createInvoice({
      customer_id: customer,
      invoice_number: 'INV-EE-2025-06-WRONG',
      gross_amount: 12400,
      vat_amount: 2400,
      tax_point_date: '2025-06-15',
      supply_type: 'services',
    });
    const refusal = await postInvoice(wrongRate).expect(422);
    expect((refusal.body as { code: string }).code).toBe(
      'vat_amount_conflicts_with_treatment',
    );
  });
});
