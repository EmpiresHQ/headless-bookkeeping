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
import { EntitiesService } from '../src/entities/entities.service';
import { MastraService } from '../src/ai/mastra.service';
import { fauxMastraService } from './faux-mastra.service';
import { createHash } from 'crypto';
import { ZodValidationPipe } from '../src/common/pipes/zod-validation.pipe';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import request from 'supertest';
import { App } from 'supertest/types';

/**
 * The prepayment HTTP contract (issue #201), over the REAL request path with
 * the production {@link ZodValidationPipe} installed.
 *
 * Two things can only be checked here, not in the service tests:
 *  - the create endpoint still accepts the POST the existing client sends —
 *    no body and no content-type at all — while the new optional `entity_id`
 *    is parsed and rejected when malformed;
 *  - an advance nobody owns is REPORTED as unresolved rather than silently
 *    attributed, and a cross-counterparty draw-down is refused end to end.
 */
describe('Prepayment HTTP contract E2E (#201)', () => {
  let app: INestApplication<App>;
  let db: Kysely<Database>;
  let root: string;
  let entitiesService: EntitiesService;
  let customerId: number;
  let apiToken: string;

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

    // Posting a SalesInvoice through the pipeline is a precondition here; the
    // auto-post kill switch is off by default.
    await db
      .insertInto('policy_config')
      .values({ key: 'auto_post_enabled', value: 'true', updated_at: 0 })
      .execute();

    root = mkdtempSync(`${tmpdir()}/prepayment-http-e2e-`);

    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(KYSELY_MODULE_CONNECTION_TOKEN())
      .useValue(db)
      .overrideProvider(DOCUMENT_STORAGE_ROOT)
      .useValue(root)
      .overrideProvider(MastraService)
      .useValue(fauxMastraService)
      // Issue #203: the FX rate source is the ONE boundary at which
      // authoritative rates enter the system. An e2e test binds it to a
      // deterministic fixture, so booting the app never reaches the ECB.
      .overrideProvider(FX_RATE_SOURCE)
      .useValue(new FixtureFxRateSource(ECB_FIXTURE_RATES))
      .compile();

    app = module.createNestApplication();
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();

    apiToken = 'test-token-prepay-12345';
    const tokenHash = createHash('sha256').update(apiToken).digest('hex');
    await db
      .insertInto('api_token')
      .values({ token_hash: tokenHash, label: 'e2e-prepayment' })
      .execute();

    entitiesService = module.get(EntitiesService);
    const customer = await entitiesService.onboard({
      role: 'customer',
      country: 'IE',
      name: 'Test Customer',
      registrationKey: 'IE-CUST-201',
      goodsVsServices: 'unknown',
    });
    customerId = customer.id;
  });

  afterEach(async () => {
    await app.close();
    await db.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  /** Upload a one-line statement and return that transaction's id. */
  async function seedIncomingLine(
    amount: number,
    transactionDate = '2024-02-01',
  ): Promise<number> {
    const res = await request(app.getHttpServer())
      .post('/api/bank-statements')
      .set('Authorization', `Bearer ${apiToken}`)
      .send({
        account_code: 'BANK_EUR',
        start_date: '2024-02-01',
        end_date: '2024-02-28',
        transactions: [
          {
            transaction_date: transactionDate,
            amount,
            currency: 'EUR',
            description: 'Advance payment',
          },
        ],
      })
      .expect(201);
    const body = res.body as { transactions: Array<{ id: number }> };
    return body.transactions[0].id;
  }

  /** Post a SalesInvoice for `customer` through the pipeline. */
  async function postSalesInvoice(
    invoiceNumber: string,
    grossAmount: number,
    customer: number,
  ): Promise<number> {
    const createRes = await request(app.getHttpServer())
      .post('/api/sales-invoices')
      .set('Authorization', `Bearer ${apiToken}`)
      .send({
        invoice_number: invoiceNumber,
        gross_amount: grossAmount,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2024-01-10',
        customer_id: customer,
      })
      .expect(201);
    const invoiceId = Reflect.get(createRes.body, 'id') as number;

    const postRes = await request(app.getHttpServer())
      .post(`/api/sales-invoices/${invoiceId}/post`)
      .set('Authorization', `Bearer ${apiToken}`)
      .expect(201);
    const result = postRes.body as { voucher: { id: number } };
    return result.voucher.id;
  }

  it('creates a prepayment from a POST with NO body, and reports it unresolved', async () => {
    const txnId = await seedIncomingLine(7000);

    // The existing client sends no body and no content-type at all: the
    // optional owner must not make the request itself invalid.
    const prepayRes = await request(app.getHttpServer())
      .post(`/api/bank-transactions/${txnId}/prepayment`)
      .set('Authorization', `Bearer ${apiToken}`)
      .expect(201);
    const prepayVoucherId = Reflect.get(prepayRes.body, 'id') as number;

    const listRes = await request(app.getHttpServer())
      .get('/api/prepayments')
      .set('Authorization', `Bearer ${apiToken}`)
      .expect(200);
    const prepayments = listRes.body as Array<{
      voucher_id: number;
      entity_id: number | null;
      allocatable: boolean;
      unresolved_reason: string | null;
    }>;
    const row = prepayments.find((p) => p.voucher_id === prepayVoucherId)!;
    // Nobody could be resolved from the bank line, so it is visible but not
    // allocatable — never silently attributed to the caller.
    expect(row.entity_id).toBeNull();
    expect(row.allocatable).toBe(false);
    expect(row.unresolved_reason).toBe('unknown_counterparty');

    // And it cannot be drawn down while it belongs to nobody.
    const arVoucherId = await postSalesInvoice('INV-HTTP-1', 7000, customerId);
    await request(app.getHttpServer())
      .post(`/api/prepayments/${prepayVoucherId}/draw-down`)
      .set('Authorization', `Bearer ${apiToken}`)
      .send({ invoice_voucher_id: arVoucherId, amount: 1000 })
      .expect(409);
  });

  it('accepts an explicit owner and draws it down against that customer', async () => {
    const arVoucherId = await postSalesInvoice('INV-HTTP-2', 5000, customerId);
    const txnId = await seedIncomingLine(5000, '2024-02-02');

    const prepayRes = await request(app.getHttpServer())
      .post(`/api/bank-transactions/${txnId}/prepayment`)
      .set('Authorization', `Bearer ${apiToken}`)
      .send({ entity_id: customerId })
      .expect(201);
    const prepayVoucherId = Reflect.get(prepayRes.body, 'id') as number;

    await request(app.getHttpServer())
      .post(`/api/prepayments/${prepayVoucherId}/draw-down`)
      .set('Authorization', `Bearer ${apiToken}`)
      .send({ invoice_voucher_id: arVoucherId, amount: 5000 })
      .expect(201);

    // Fully drawn: no longer outstanding.
    const listRes = await request(app.getHttpServer())
      .get('/api/prepayments')
      .set('Authorization', `Bearer ${apiToken}`)
      .expect(200);
    const prepayments = listRes.body as Array<{ voucher_id: number }>;
    expect(
      prepayments.find((p) => p.voucher_id === prepayVoucherId),
    ).toBeUndefined();
  });

  it('rejects a malformed owner and a malformed draw-down through the pipe', async () => {
    const txnId = await seedIncomingLine(3000, '2024-02-03');

    await request(app.getHttpServer())
      .post(`/api/bank-transactions/${txnId}/prepayment`)
      .set('Authorization', `Bearer ${apiToken}`)
      .send({ entity_id: 'not-a-number' })
      .expect(400);

    const prepayRes = await request(app.getHttpServer())
      .post(`/api/bank-transactions/${txnId}/prepayment`)
      .set('Authorization', `Bearer ${apiToken}`)
      .send({ entity_id: customerId })
      .expect(201);
    const prepayVoucherId = Reflect.get(prepayRes.body, 'id') as number;

    // A fractional amount is not a whole number of minor units.
    await request(app.getHttpServer())
      .post(`/api/prepayments/${prepayVoucherId}/draw-down`)
      .set('Authorization', `Bearer ${apiToken}`)
      .send({ invoice_voucher_id: 1, amount: 10.5 })
      .expect(400);
  });

  it('refuses a draw-down across counterparties', async () => {
    const arVoucherId = await postSalesInvoice('INV-HTTP-3', 6000, customerId);

    const otherRes = await request(app.getHttpServer())
      .post('/api/entities')
      .set('Authorization', `Bearer ${apiToken}`)
      .send({
        role: 'customer',
        country: 'IE',
        name: 'Other Customer Ltd',
        registrationKey: 'IE-CUST-202',
        goodsVsServices: 'unknown',
      })
      .expect(201);
    const otherCustomerId = Reflect.get(otherRes.body, 'id') as number;

    const txnId = await seedIncomingLine(6000, '2024-02-04');
    const prepayRes = await request(app.getHttpServer())
      .post(`/api/bank-transactions/${txnId}/prepayment`)
      .set('Authorization', `Bearer ${apiToken}`)
      .send({ entity_id: otherCustomerId })
      .expect(201);
    const prepayVoucherId = Reflect.get(prepayRes.body, 'id') as number;

    await request(app.getHttpServer())
      .post(`/api/prepayments/${prepayVoucherId}/draw-down`)
      .set('Authorization', `Bearer ${apiToken}`)
      .send({ invoice_voucher_id: arVoucherId, amount: 1000 })
      .expect(400);
  });
});
