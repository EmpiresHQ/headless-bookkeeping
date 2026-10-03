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
import { ExpensesService } from '../src/expenses/expenses.service';
import { validateAgainstKmdXsd } from '../src/plugins/estonia-kmd/xsd-validate';
import request from 'supertest';
import { App } from 'supertest/types';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

const xsd = readFileSync(
  join(__dirname, 'fixtures/vatdeclaration.xsd'),
  'utf8',
);

/**
 * Reverse-charge acquisitions: WHERE they are declared (issue #210), end to end
 * over real HTTP against a real (in-memory) database.
 *
 * The reported defect is the one asserted first, in the form it was reported:
 * a EUR 100 software service bought from a Finnish taxable supplier, document
 * VAT zero, reached `row7_other_acquisition = 10000` with row 6 empty — because
 * one reverse-charge code served for every origin and the classifier always
 * answered row 7. Here the supplier's recorded facts decide the origin, it is
 * frozen into the VAT code at posting, and the declaration, the XML and the CSV
 * all agree.
 */
describe('Reverse-charge acquisition origin (E2E)', () => {
  let app: INestApplication<App>;
  let db: Kysely<Database>;
  let root: string;
  let token: string;

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

    // These cases are about WHAT gets posted, not about the approval gate.
    await db
      .insertInto('policy_config')
      .values({ key: 'auto_post_enabled', value: 'true', updated_at: 0 })
      .execute();

    root = mkdtempSync(join(tmpdir(), 'reverse-charge-e2e-'));

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

    token = 'test-token-reverse-charge-1234';
    await db
      .insertInto('api_token')
      .values({
        token_hash: createHash('sha256').update(token).digest('hex'),
        label: 'e2e-reverse-charge',
      })
      .execute();

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

  interface SupplierFacts {
    country: string;
    name: string;
    registrationKey: string;
    goodsVsServices?: 'goods' | 'services' | 'unknown';
    taxStatus?: 'taxable_business' | 'non_taxable' | 'unknown';
  }

  async function addSupplier(facts: SupplierFacts): Promise<number> {
    const res = await request(app.getHttpServer())
      .post('/api/entities')
      .set(auth())
      .send({ role: 'supplier', ...facts })
      .expect(201);
    return (res.body as { id: number }).id;
  }

  async function createExpense(body: Record<string, unknown>): Promise<number> {
    const res = await request(app.getHttpServer())
      .post('/api/expenses')
      .set(auth())
      .send({
        category: 'software',
        currency: 'EUR',
        tax_point_date: TAX_POINT,
        ...body,
      })
      .expect(201);
    return (res.body as { id: number }).id;
  }

  const postExpense = (id: number) =>
    request(app.getHttpServer())
      .post(`/api/expenses/${id}/post`)
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

  async function kmdCsv(): Promise<string> {
    const res = await request(app.getHttpServer())
      .get(
        `/api/reporting-periods/${await periodId()}/statutory-report?format=csv`,
      )
      .set(auth())
      .expect(200);
    return res.text;
  }

  /** The VAT code(s) the posted expense's cost leg carries in the ledger. */
  async function expenseVatCodes(expenseId: number): Promise<string[]> {
    const rows = await db
      .selectFrom('expense as e')
      .innerJoin('voucher_line as vl', 'vl.voucher_id', 'e.voucher_id')
      .innerJoin('account as a', 'a.id', 'vl.account_id')
      .select(['vl.vat_code'])
      .where('e.id', '=', expenseId)
      .where('a.code', '=', 'EXPENSE_SOFTWARE')
      .execute();
    return rows.map((r) => r.vat_code ?? '');
  }

  // ── The reported case, and its counterpart ───────────────────────────────

  it('an acquisition from a taxable person of another member state is declared in row 6, not row 7', async () => {
    // The bug report's reproduction, verbatim: EE organization, Finnish taxable
    // supplier, EUR 100 software service, document VAT zero.
    const supplier = await addSupplier({
      country: 'FI',
      name: 'Suomi Software Oy',
      registrationKey: 'FI12345678',
      goodsVsServices: 'services',
      taxStatus: 'taxable_business',
    });
    const id = await createExpense({
      supplier_id: supplier,
      gross_amount: 10000,
      vat_amount: 0,
      supplier_invoice_number: 'FI-1',
    });
    await postExpense(id).expect(201);

    const d = await declaration();
    // The reported symptoms first, so a regression names the defect.
    expect(d.row7_other_acquisition).toBe(0);
    expect(d.row6_intra_eu_acquisition).toBe(10000);
    expect(d.row6_7_unresolved_acquisition).toBe(0);
    expect(d.unresolved_acquisition_vouchers).toEqual([]);
    // The self-assessed VAT is unaffected: output and input both 24 EUR.
    expect(d.row1_base_24).toBe(10000);
    expect(d.row4_output_vat).toBe(2400);
    expect(d.row5_input_vat).toBe(2400);
    expect(d.net_vat_due).toBe(0);
    expect(await expenseVatCodes(id)).toEqual(['EE_REVERSE_CHARGE_EU']);

    const xml = await kmdXml();
    expect(xml).toContain(
      '<euAcquisitionsGoodsAndServicesTotal>100.00</euAcquisitionsGoodsAndServicesTotal>',
    );
    expect(xml).not.toContain('acquisitionOtherGoodsAndServicesTotal');
    expect(validateAgainstKmdXsd(xml, xsd)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('an acquisition from outside the Community stays in row 7', async () => {
    const supplier = await addSupplier({
      country: 'US',
      name: 'Stateside Inc',
      registrationKey: 'US99-1234567',
      goodsVsServices: 'services',
      taxStatus: 'taxable_business',
    });
    const id = await createExpense({
      supplier_id: supplier,
      gross_amount: 25000,
      vat_amount: 0,
      supplier_invoice_number: 'US-1',
    });
    await postExpense(id).expect(201);

    const d = await declaration();
    expect(d.row7_other_acquisition).toBe(25000);
    expect(d.row6_intra_eu_acquisition).toBe(0);
    expect(await expenseVatCodes(id)).toEqual([
      'EE_REVERSE_CHARGE_3RD_COUNTRY',
    ]);

    const xml = await kmdXml();
    expect(xml).toContain(
      '<acquisitionOtherGoodsAndServicesTotal>250.00</acquisitionOtherGoodsAndServicesTotal>',
    );
    expect(xml).not.toContain('euAcquisitionsGoodsAndServicesTotal');
  });

  it('mixed EU and non-EU acquisitions, and their reversals, keep to their own rows in one period', async () => {
    const fi = await addSupplier({
      country: 'FI',
      name: 'Suomi Oy',
      registrationKey: 'FI22222222',
      goodsVsServices: 'services',
      taxStatus: 'taxable_business',
    });
    const us = await addSupplier({
      country: 'US',
      name: 'Third Country Inc',
      registrationKey: 'US88-8888888',
      goodsVsServices: 'services',
      taxStatus: 'taxable_business',
    });

    const euKept = await createExpense({
      supplier_id: fi,
      gross_amount: 10000,
      vat_amount: 0,
      supplier_invoice_number: 'FI-KEEP',
    });
    const euReversed = await createExpense({
      supplier_id: fi,
      gross_amount: 4000,
      vat_amount: 0,
      supplier_invoice_number: 'FI-REV',
    });
    const nonEuKept = await createExpense({
      supplier_id: us,
      gross_amount: 25000,
      vat_amount: 0,
      supplier_invoice_number: 'US-KEEP',
    });
    const nonEuReduced = await createExpense({
      supplier_id: us,
      gross_amount: 9000,
      vat_amount: 0,
      supplier_invoice_number: 'US-FIX',
    });
    for (const id of [euKept, euReversed, nonEuKept, nonEuReduced]) {
      await postExpense(id).expect(201);
    }

    // A full reversal of one EU acquisition …
    await request(app.getHttpServer())
      .post(`/api/expenses/${euReversed}/correct`)
      .set(auth())
      .send({ kind: 'reversal', reason: 'never received' })
      .expect(201);
    // … and a partial correction of one third-country acquisition.
    await request(app.getHttpServer())
      .post(`/api/expenses/${nonEuReduced}/correct`)
      .set(auth())
      .send({
        kind: 'financial',
        reason: 'overstated',
        patch: { gross_amount: 6000 },
      })
      .expect(201);

    const d = await declaration();
    expect(d.row6_intra_eu_acquisition).toBe(10000); // 100 + 40 − 40
    expect(d.row7_other_acquisition).toBe(31000); // 250 + 90 − 90 + 60
    expect(d.row6_7_unresolved_acquisition).toBe(0);
    expect(d.row1_base_24).toBe(41000);
    // Each acquisition contributes ONE base, whatever its three VAT legs do.
    expect(d.row4_output_vat).toBe(Math.round(41000 * 0.24));
    expect(d.row5_input_vat).toBe(Math.round(41000 * 0.24));

    const csv = await kmdCsv();
    const kmd6 = csv.split('\r\n')[0].split(';');
    expect(kmd6[23]).toBe('100.00'); // euAcquisitionsGoodsAndServicesTotal
    expect(kmd6[25]).toBe('310.00'); // acquisitionOtherGoodsAndServicesTotal
    expect(validateAgainstKmdXsd(await kmdXml(), xsd)).toEqual({
      valid: true,
      errors: [],
    });
  });

  // ── Refusals: nothing is posted on facts we do not have ─────────────────

  it('REFUSES an EU acquisition while the supplier tax status is unknown, then posts once it is supplied', async () => {
    const supplier = await addSupplier({
      country: 'FI',
      name: 'Tuntematon Oy',
      registrationKey: 'FI11112222',
      goodsVsServices: 'services',
      // taxStatus deliberately not supplied — the pre-#210 state of every
      // supplier. Unknown is not "taxable business".
    });
    const id = await createExpense({
      supplier_id: supplier,
      gross_amount: 10000,
      vat_amount: 0,
      supplier_invoice_number: 'FI-UNKNOWN',
    });

    const refusal = await postExpense(id).expect(422);
    const body = refusal.body as {
      code: string;
      missing_facts: string[];
      how_to_resolve: string;
    };
    expect(body.code).toBe('supplier_tax_status_unknown');
    expect(body.how_to_resolve).toContain('PATCH /api/entities');

    // Nothing was posted: still a draft, no voucher, empty declaration.
    const after = await request(app.getHttpServer())
      .get('/api/expenses')
      .set(auth())
      .expect(200);
    const expense = (
      after.body as {
        expenses: { id: number; status: string; voucher_id: number | null }[];
      }
    ).expenses.find((e) => e.id === id)!;
    expect(expense.status).toBe('draft');
    expect(expense.voucher_id).toBeNull();
    const empty = await declaration();
    expect(empty.row6_intra_eu_acquisition).toBe(0);
    expect(empty.row7_other_acquisition).toBe(0);
    expect(empty.row1_base_24).toBe(0);

    // The named remedy is the whole remedy — on the same expense.
    await request(app.getHttpServer())
      .patch(`/api/entities/${supplier}`)
      .set(auth())
      .send({ taxStatus: 'taxable_business' })
      .expect(200);
    await postExpense(id).expect(201);
    expect(await expenseVatCodes(id)).toEqual(['EE_REVERSE_CHARGE_EU']);
    expect((await declaration()).row6_intra_eu_acquisition).toBe(10000);
  });

  it('REFUSES a non-EU acquisition on unknown facts rather than stamping row 7 on it', async () => {
    const unknownStatus = await addSupplier({
      country: 'US',
      name: 'Unknown Status Inc',
      registrationKey: 'US11-1111111',
      goodsVsServices: 'services',
    });
    const a = await createExpense({
      supplier_id: unknownStatus,
      gross_amount: 10000,
      vat_amount: 0,
      supplier_invoice_number: 'US-UNKNOWN',
    });
    expect((await postExpense(a).expect(422)).body).toMatchObject({
      code: 'supplier_tax_status_unknown',
    });

    const unknownSupply = await addSupplier({
      country: 'US',
      name: 'Unknown Supply Inc',
      registrationKey: 'US22-2222222',
      taxStatus: 'taxable_business',
    });
    const b = await createExpense({
      supplier_id: unknownSupply,
      gross_amount: 10000,
      vat_amount: 0,
      supplier_invoice_number: 'US-NO-TYPE',
    });
    expect((await postExpense(b).expect(422)).body).toMatchObject({
      code: 'acquisition_supply_type_unknown',
    });

    const consumer = await addSupplier({
      country: 'US',
      name: 'Private Person',
      registrationKey: 'US33-3333333',
      goodsVsServices: 'services',
      taxStatus: 'non_taxable',
    });
    const c = await createExpense({
      supplier_id: consumer,
      gross_amount: 10000,
      vat_amount: 0,
      supplier_invoice_number: 'US-B2C',
    });
    expect((await postExpense(c).expect(422)).body).toMatchObject({
      code: 'supplier_non_taxable_acquisition_unsupported',
    });

    const d = await declaration();
    expect(d.row7_other_acquisition).toBe(0);
    expect(d.row1_base_24).toBe(0);
  });

  // ── Stale facts never post, and never get approved ──────────────────────

  it('REFUSES a post whose prepared entry was overtaken by a supplier correction', async () => {
    // The status claim cannot see this one: the expense itself does not change,
    // only the supplier facts that decide its acquisition row. Without the
    // guard the pipeline would post the entry it derived BEFORE the change.
    {
      const supplier = await addSupplier({
        country: 'FI',
        name: 'Kilpajuoksu Oy',
        registrationKey: 'FI40404040',
        goodsVsServices: 'services',
        taxStatus: 'taxable_business',
      });
      const id = await createExpense({
        supplier_id: supplier,
        gross_amount: 10000,
        vat_amount: 0,
        supplier_invoice_number: 'FI-RACE',
      });

      // Controlled pause: the supplier's country moves out of the Community
      // between draft generation and the posting transaction.
      const service = app.get(ExpensesService);
      const original = service.generateDraftVoucher.bind(service);
      const spy = jest
        .spyOn(service, 'generateDraftVoucher')
        .mockImplementation(async (expenseId: number) => {
          const draft = await original(expenseId);
          if (expenseId === id) {
            await request(app.getHttpServer())
              .patch(`/api/entities/${supplier}`)
              .set(auth())
              .send({ country: 'US' })
              .expect(200);
          }
          return draft;
        });

      const refusal = await postExpense(id).expect(409);
      spy.mockRestore();
      expect((refusal.body as { message: string }).message).toMatch(
        /changed while it was being posted/,
      );

      // Nothing was posted or held, and no voucher exists at all.
      const after = await db
        .selectFrom('expense')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(after).toMatchObject({ status: 'draft', voucher_id: null });
      expect(await db.selectFrom('voucher').selectAll().execute()).toHaveLength(
        0,
      );

      // Posting again recomputes from the CURRENT facts: a third-country
      // acquisition now, row 7 — not the intra-EU entry that was prepared.
      await postExpense(id).expect(201);
      expect(await expenseVatCodes(id)).toEqual([
        'EE_REVERSE_CHARGE_3RD_COUNTRY',
      ]);
      const d = await declaration();
      expect(d.row7_other_acquisition).toBe(10000);
      expect(d.row6_intra_eu_acquisition).toBe(0);
    }
  });

  it('an APPROVAL posts the facts as they are at approval time, not the ones it was raised on', async () => {
    // Over the auto-post ceiling, so Policy holds it and a real approval exists.
    const supplier = await addSupplier({
      country: 'FI',
      name: 'Suuri Oy',
      registrationKey: 'FI30303030',
      goodsVsServices: 'services',
      taxStatus: 'taxable_business',
    });
    const id = await createExpense({
      supplier_id: supplier,
      gross_amount: 500000,
      vat_amount: 0,
      supplier_invoice_number: 'FI-HELD',
    });
    const held = await postExpense(id).expect(201);
    expect(held.body).toMatchObject({
      policy: { action: 'hold-for-approval' },
      expense: { status: 'pending' },
    });

    const pending = await request(app.getHttpServer())
      .get('/api/approvals/pending')
      .set(auth())
      .expect(200);
    const approval = (
      pending.body as {
        approvals: { id: number; object_type: string; object_id: number }[];
      }
    ).approvals.find((a) => a.object_type === 'expense' && a.object_id === id)!;
    expect(approval).toBeDefined();

    // The supplier turns out to be established outside the Community.
    await request(app.getHttpServer())
      .patch(`/api/entities/${supplier}`)
      .set(auth())
      .send({ country: 'US' })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/approvals/${approval.id}/approve`)
      .set(auth())
      .send({ approved_by: 'operator' })
      .expect(201);

    // The approval re-derives the entry, so the posted acquisition carries the
    // corrected origin — row 7 — and nothing of the stale one survives.
    expect(await expenseVatCodes(id)).toEqual([
      'EE_REVERSE_CHARGE_3RD_COUNTRY',
    ]);
    const d = await declaration();
    expect(d.row7_other_acquisition).toBe(500000);
    expect(d.row6_intra_eu_acquisition).toBe(0);
  });

  // ── The legacy code: blocked, then recovered through the documented API ──

  it('a legacy origin-less acquisition blocks the filing, and the error message names a call that works', async () => {
    // A pre-#210 posting: the expense is real and its voucher carries the old
    // collapsed code. Nothing in the system can produce this any more, which is
    // why it is written straight into the ledger here.
    const supplier = await addSupplier({
      country: 'FI',
      name: 'Vana Oy',
      registrationKey: 'FI99998888',
      goodsVsServices: 'services',
      taxStatus: 'taxable_business',
    });
    const expenseId = await createExpense({
      supplier_id: supplier,
      gross_amount: 10000,
      vat_amount: 0,
      supplier_invoice_number: 'FI-LEGACY',
    });

    const accounts = await db
      .selectFrom('account')
      .select(['id', 'code'])
      .where('code', 'in', [
        'EXPENSE_SOFTWARE',
        'VAT_RECEIVABLE',
        'AP',
        'VAT_PAYABLE',
      ])
      .execute();
    const accountId = (code: string) =>
      accounts.find((a) => a.code === code)!.id;
    const legacyVoucher = await db
      .insertInto('voucher')
      .values({
        voucher_number: 'V-2026-000900',
        tax_point_date: TAX_POINT,
        posted_at: Math.floor(Date.now() / 1000),
        previous_hash: null,
        reverses_id: null,
        corrects_object_type: null,
        corrects_object_id: null,
        reason: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const [code, amount, isDebit, vatCode] of [
      ['EXPENSE_SOFTWARE', 10000, 1, 'EE_REVERSE_CHARGE'],
      ['VAT_RECEIVABLE', 2400, 1, 'EE_REVERSE_CHARGE'],
      ['AP', 10000, 0, null],
      ['VAT_PAYABLE', 2400, 0, 'EE_REVERSE_CHARGE'],
    ] as const) {
      await db
        .insertInto('voucher_line')
        .values({
          voucher_id: legacyVoucher.id,
          account_id: accountId(code),
          amount,
          currency: 'EUR',
          base_amount: amount,
          fx_rate: 1,
          vat_code: vatCode,
          is_debit: isDebit,
        })
        .execute();
    }
    await db
      .updateTable('expense')
      .set({ status: 'posted', voucher_id: legacyVoucher.id })
      .where('id', '=', expenseId)
      .execute();

    // It is in neither acquisition row, and it is named.
    const before = await declaration();
    expect(before.row6_intra_eu_acquisition).toBe(0);
    expect(before.row7_other_acquisition).toBe(0);
    expect(before.row6_7_unresolved_acquisition).toBe(10000);
    expect(before.unresolved_acquisition_vouchers).toEqual(['V-2026-000900']);

    // The seeded 2024-Q1 period sits before ours and must be filed first; it
    // is empty, so this is just clearing the way to the period under test.
    await request(app.getHttpServer())
      .post('/api/reporting-periods/1/lock')
      .set(auth())
      .expect(201);

    // Filing is refused, and the period is left exactly as it was.
    const refusal = await request(app.getHttpServer())
      .post(`/api/reporting-periods/${await periodId()}/lock`)
      .set(auth())
      .expect(409);
    expect((refusal.body as { message: string }).message).toContain(
      'V-2026-000900',
    );
    const period = await request(app.getHttpServer())
      .get(`/api/reporting-periods/${await periodId()}`)
      .set(auth())
      .expect(200);
    expect(period.body).toMatchObject({
      status: 'open',
      vat_report_snapshot_id: null,
    });
    expect(
      await db
        .selectFrom('statutory_filing_snapshot')
        .selectAll()
        .where('reporting_period_id', '=', await periodId())
        .execute(),
    ).toEqual([]);

    // The remedy the refusal names, exactly as it is written there.
    await request(app.getHttpServer())
      .post(`/api/expenses/${expenseId}/correct`)
      .set(auth())
      .send({ kind: 'financial', reason: 'record the acquisition origin' })
      .expect(201);

    const after = await declaration();
    expect(after.row6_intra_eu_acquisition).toBe(10000);
    expect(after.row7_other_acquisition).toBe(0);
    expect(after.row6_7_unresolved_acquisition).toBe(0);
    expect(after.unresolved_acquisition_vouchers).toEqual([]);
    // One acquisition, not two: the reversal cancelled the original.
    expect(after.row1_base_24).toBe(10000);

    // And now the period files.
    await request(app.getHttpServer())
      .post(`/api/reporting-periods/${await periodId()}/lock`)
      .set(auth())
      .expect(201);
    const xml = await kmdXml();
    expect(xml).toContain(
      '<euAcquisitionsGoodsAndServicesTotal>100.00</euAcquisitionsGoodsAndServicesTotal>',
    );
    expect(validateAgainstKmdXsd(xml, xsd)).toEqual({
      valid: true,
      errors: [],
    });
  });
});
