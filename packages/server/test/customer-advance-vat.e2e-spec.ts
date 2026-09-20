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
import { ZodValidationPipe } from '../src/common/pipes/zod-validation.pipe';
import request from 'supertest';
import { App } from 'supertest/types';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

/**
 * Issue #213, end to end over real HTTP: a customer advance that pays for an
 * identified taxable supply.
 *
 * The reported case is asserted first, in the form it was reported — an open
 * EUR 124.00 receipt dated 2026-02-10 for a domestic service taxable at 24%,
 * turned into a prepayment, used to show VAT_PAYABLE zero and period output
 * VAT zero. Here it declares EUR 24.00 on the receipt date, the final invoice
 * in the NEXT period does not declare it twice, and the filing of a period
 * holding an unclassified receipt is refused.
 */
describe('Customer advance VAT (E2E, #213)', () => {
  let app: INestApplication<App>;
  let db: Kysely<Database>;
  let root: string;
  let token: string;
  let customerId: number;

  const FEB = { name: '2026-02', start: '2026-02-01', end: '2026-02-28' };
  const MAR = { name: '2026-03', start: '2026-03-01', end: '2026-03-31' };
  const CUSTOMER_IBAN = 'EE381700017000000001';

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

    await db
      .insertInto('policy_config')
      .values({ key: 'auto_post_enabled', value: 'true', updated_at: 0 })
      .execute();

    root = mkdtempSync(join(tmpdir(), 'advance-vat-e2e-'));

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
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();

    token = 'test-token-advance-vat-1234';
    await db
      .insertInto('api_token')
      .values({
        token_hash: createHash('sha256').update(token).digest('hex'),
        label: 'e2e-advance-vat',
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

    // The seeded calendar starts before these periods, and a period cannot be
    // filed while an earlier one is still open. These cases are about the
    // advance guards, so the calendar is exactly the two months they use.
    await db.deleteFrom('reporting_period').execute();

    for (const p of [FEB, MAR]) {
      await request(app.getHttpServer())
        .post('/api/reporting-periods')
        .set(auth())
        .send({ name: p.name, start_date: p.start, end_date: p.end })
        .expect(201);
    }

    const customerRes = await request(app.getHttpServer())
      .post('/api/entities')
      .set(auth())
      .send({
        role: 'customer',
        country: 'EE',
        name: 'Klient OÜ',
        registrationKey: '12345678',
        goodsVsServices: 'services',
        taxStatus: 'taxable_business',
      })
      .expect(201);
    customerId = (customerRes.body as { id: number }).id;
    await request(app.getHttpServer())
      .post(`/api/entities/${customerId}/aliases`)
      .set(auth())
      .send({ kind: 'iban', value: CUSTOMER_IBAN, confirmed: true })
      .expect(201);
  });

  afterEach(async () => {
    await app.close();
    await db.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  // ── API helpers (all real HTTP) ────────────────────────────────────

  async function seedLine(
    amount: number,
    transactionDate: string,
    opts: { iban?: string | null } = {},
  ): Promise<number> {
    const res = await request(app.getHttpServer())
      .post('/api/bank-statements')
      .set(auth())
      .send({
        account_code: 'BANK_EUR',
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        transactions: [
          {
            transaction_date: transactionDate,
            amount,
            currency: 'EUR',
            description: amount > 0 ? 'Ettemaks' : 'Ettemaksu tagastus',
            counterparty_iban:
              opts.iban === undefined ? CUSTOMER_IBAN : opts.iban,
          },
        ],
      })
      .expect(201);
    return (res.body as { transactions: { id: number }[] }).transactions[0].id;
  }

  async function postSalesInvoice(
    invoiceNumber: string,
    gross: number,
    vat: number,
    taxPointDate: string,
  ): Promise<number> {
    const created = await request(app.getHttpServer())
      .post('/api/sales-invoices')
      .set(auth())
      .send({
        invoice_number: invoiceNumber,
        gross_amount: gross,
        vat_amount: vat,
        currency: 'EUR',
        tax_point_date: taxPointDate,
        customer_id: customerId,
      })
      .expect(201);
    const invoiceId = (created.body as { id: number }).id;
    const posted = await request(app.getHttpServer())
      .post(`/api/sales-invoices/${invoiceId}/post`)
      .set(auth())
      .expect(201);
    return (posted.body as { voucher: { id: number } }).voucher.id;
  }

  async function periodId(name: string): Promise<number> {
    const res = await request(app.getHttpServer())
      .get('/api/reporting-periods')
      .set(auth())
      .expect(200);
    const { reportingPeriods } = res.body as {
      reportingPeriods: { id: number; name: string }[];
    };
    const found = reportingPeriods.find((p) => p.name === name);
    if (!found) throw new Error(`period ${name} not found`);
    return found.id;
  }

  async function declaration(name: string): Promise<KmdDeclaration> {
    const res = await request(app.getHttpServer())
      .get(`/api/reporting-periods/${await periodId(name)}/kmd`)
      .set(auth())
      .expect(200);
    return res.body as KmdDeclaration;
  }

  // ── the reported case ──────────────────────────────────────────────

  it('declares 24.00 EUR on a 124.00 EUR domestic taxable advance, on the receipt date', async () => {
    const txnId = await seedLine(12400, '2026-02-10');

    await request(app.getHttpServer())
      .post(`/api/bank-transactions/${txnId}/prepayment`)
      .set(auth())
      .send({
        entity_id: customerId,
        tax_treatment: 'taxable_supply',
        vat_code: 'EE_OUTPUT_24',
        supply_description: 'Website build, delivery in March',
        advance_document_number: 'ETTEMAKS-1',
      })
      .expect(201);

    // The figures the issue reported as zero.
    const feb = await declaration(FEB.name);
    expect(feb.row4_output_vat).toBe(2400);
    expect(feb.row1_base_24).toBe(10000);
    expect(feb.unresolved_advance_receipts).toEqual([]);

    // And what the prepayment now says about itself.
    const listRes = await request(app.getHttpServer())
      .get('/api/prepayments')
      .set(auth())
      .expect(200);
    const [row] = listRes.body as Array<Record<string, unknown>>;
    expect(row.tax_treatment).toBe('taxable_supply');
    expect(row.declared_vat).toBe(2400);
    expect(row.gross_amount).toBe(12400);
    expect(row.remaining_gross).toBe(12400);
    expect(row.advance_document_number).toBe('ETTEMAKS-1');
    expect(row.allocatable).toBe(true);
  });

  it('does not declare the advance twice when the invoice lands in a later period', async () => {
    const txnId = await seedLine(12400, '2026-02-10');
    const prepayRes = await request(app.getHttpServer())
      .post(`/api/bank-transactions/${txnId}/prepayment`)
      .set(auth())
      .send({
        entity_id: customerId,
        tax_treatment: 'taxable_supply',
        vat_code: 'EE_OUTPUT_24',
        supply_description: 'Website build, delivery in March',
        advance_document_number: 'ETTEMAKS-1',
      })
      .expect(201);
    const prepayVoucherId = (prepayRes.body as { id: number }).id;

    const invoiceVoucherId = await postSalesInvoice(
      'INV-2026-1',
      12400,
      2400,
      '2026-03-05',
    );

    await request(app.getHttpServer())
      .post(`/api/prepayments/${prepayVoucherId}/draw-down`)
      .set(auth())
      .send({ invoice_voucher_id: invoiceVoucherId, amount: 12400 })
      .expect(201);

    // February keeps the 24 it declared; March declares the supply and
    // releases the advance's VAT in the same period — 24 − 24, never 48.
    const feb = await declaration(FEB.name);
    expect(feb.row4_output_vat).toBe(2400);
    const mar = await declaration(MAR.name);
    expect(mar.row4_output_vat).toBe(0);
    expect(mar.row1_base_24).toBe(0);

    // Over both periods, the supply was declared exactly once.
    expect(feb.row4_output_vat + mar.row4_output_vat).toBe(2400);
  });

  it('refunds the advance and takes its declared VAT back, once', async () => {
    const txnId = await seedLine(12400, '2026-02-10');
    const prepayRes = await request(app.getHttpServer())
      .post(`/api/bank-transactions/${txnId}/prepayment`)
      .set(auth())
      .send({
        entity_id: customerId,
        tax_treatment: 'taxable_supply',
        vat_code: 'EE_OUTPUT_24',
        supply_description: 'Website build, delivery in March',
        advance_document_number: 'ETTEMAKS-1',
      })
      .expect(201);
    const prepayVoucherId = (prepayRes.body as { id: number }).id;

    const refundTxnId = await seedLine(-12400, '2026-03-12');
    await request(app.getHttpServer())
      .post(`/api/prepayments/${prepayVoucherId}/refund`)
      .set(auth())
      .send({
        bank_transaction_id: refundTxnId,
        credit_reference: 'KREEDIT-1',
        reason: 'Order cancelled by the customer',
      })
      .expect(201);

    const mar = await declaration(MAR.name);
    expect(mar.row4_output_vat).toBe(-2400);
    expect(mar.row1_base_24).toBe(-10000);

    // A retry of the same refund is refused, so the VAT is never released
    // twice on one payment.
    await request(app.getHttpServer())
      .post(`/api/prepayments/${prepayVoucherId}/refund`)
      .set(auth())
      .send({
        bank_transaction_id: refundTxnId,
        credit_reference: 'KREEDIT-1',
        reason: 'retry',
      })
      .expect(409);
  });

  // ── the held receipt, and the filing gate ──────────────────────────

  it('holds an unclassified receipt and refuses to file the period until it is classified', async () => {
    const txnId = await seedLine(12400, '2026-02-10');
    // The bodyless POST the existing client sends.
    const prepayRes = await request(app.getHttpServer())
      .post(`/api/bank-transactions/${txnId}/prepayment`)
      .set(auth())
      .expect(201);
    const prepayVoucherId = (prepayRes.body as { id: number }).id;

    const feb = await declaration(FEB.name);
    expect(feb.unresolved_advance_receipts).toHaveLength(1);
    expect(feb.unresolved_advance_base).toBe(12400);

    // A draft statutory export renders, but names it as blocking.
    const draft = await request(app.getHttpServer())
      .get(
        `/api/reporting-periods/${await periodId(FEB.name)}/statutory-report?format=xml`,
      )
      .set(auth());
    expect(draft.status).toBe(200);

    // Filing the period is refused while the receipt says nothing.
    const locked = await request(app.getHttpServer())
      .post(`/api/reporting-periods/${await periodId(FEB.name)}/lock`)
      .set(auth());
    expect(locked.status).toBe(409);
    expect(JSON.stringify(locked.body)).toContain('tax-treatment');

    // Classified as a taxable advance, the receipt declares its VAT at the
    // date the money arrived, and the period files.
    await request(app.getHttpServer())
      .post(`/api/prepayments/${prepayVoucherId}/tax-treatment`)
      .set(auth())
      .send({
        tax_treatment: 'taxable_supply',
        vat_code: 'EE_OUTPUT_24',
        supply_description: 'Website build, delivery in March',
        advance_document_number: 'ETTEMAKS-1',
      })
      .expect(201);

    const after = await declaration(FEB.name);
    expect(after.unresolved_advance_receipts).toEqual([]);
    expect(after.row4_output_vat).toBe(2400);

    await request(app.getHttpServer())
      .post(`/api/reporting-periods/${await periodId(FEB.name)}/lock`)
      .set(auth())
      .expect(201);
  });

  it('lists the advance VAT treatments the jurisdiction supports on a date', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/prepayments/advance-vat-treatments?receipt_date=2026-02-10')
      .set(auth())
      .expect(200);
    const { treatments } = res.body as {
      treatments: { vat_code: string; rate_permille: number }[];
    };
    expect(treatments).toContainEqual({
      vat_code: 'EE_OUTPUT_24',
      rate_permille: 240,
    });
    // A 0% intra-Community supply is NOT advanced by a payment, so it is not
    // offered as an advance treatment at all.
    expect(treatments.map((t) => t.vat_code)).not.toContain('EE_OUTPUT_0_EU');
  });

  it('refuses a draw-down whose invoice sits in a filed period', async () => {
    const txnId = await seedLine(12400, '2026-02-10');
    const prepayRes = await request(app.getHttpServer())
      .post(`/api/bank-transactions/${txnId}/prepayment`)
      .set(auth())
      .send({
        entity_id: customerId,
        tax_treatment: 'taxable_supply',
        vat_code: 'EE_OUTPUT_24',
        supply_description: 'Website build, delivery in March',
        advance_document_number: 'ETTEMAKS-1',
      })
      .expect(201);
    const prepayVoucherId = (prepayRes.body as { id: number }).id;

    const invoiceVoucherId = await postSalesInvoice(
      'INV-2026-2',
      12400,
      2400,
      '2026-03-05',
    );
    // A period is filed in order, so February goes first — it declared the
    // advance and has nothing unclassified in it.
    await request(app.getHttpServer())
      .post(`/api/reporting-periods/${await periodId(FEB.name)}/lock`)
      .set(auth())
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/reporting-periods/${await periodId(MAR.name)}/lock`)
      .set(auth())
      .expect(201);

    // The relief belongs in March, and March is filed: refused with the
    // correction route named, never re-dated into an open period.
    const refused = await request(app.getHttpServer())
      .post(`/api/prepayments/${prepayVoucherId}/draw-down`)
      .set(auth())
      .send({ invoice_voucher_id: invoiceVoucherId, amount: 12400 })
      .expect(409);
    expect(JSON.stringify(refused.body)).toContain('locked period');
  });
});
