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
 * Issue #215 over real HTTP: the organisation's base currency and jurisdiction
 * are the UNIT of every amount already posted, so once a voucher exists a PUT
 * that would change them is refused — and everything else about the settings
 * endpoint keeps working exactly as before.
 *
 * The reported sequence is asserted in the form it was reported: an EUR 100
 * sale is posted at the EUR base, the base currency is then switched to USD,
 * and a second EUR 100 sale is posted — which used to leave
 * `getLedgerNet(AR) = 20870`, an EUR-measured 10000 added to a USD-measured
 * 10870. Here the switch is refused with 409, both invoices are measured the
 * same way, and the ledger and the KMD declaration agree on one basis.
 */
describe('Ledger measurement basis settings (E2E, #215)', () => {
  let app: INestApplication<App>;
  let db: Kysely<Database>;
  let root: string;
  let token: string;
  let customerId: number;

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

    await db
      .insertInto('policy_config')
      .values({ key: 'auto_post_enabled', value: 'true', updated_at: 0 })
      .execute();

    root = mkdtempSync(join(tmpdir(), 'ledger-basis-e2e-'));

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

    token = 'test-token-ledger-basis-1234';
    await db
      .insertInto('api_token')
      .values({
        token_hash: createHash('sha256').update(token).digest('hex'),
        label: 'e2e-ledger-basis',
      })
      .execute();

    // Setup BEFORE the first voucher: the jurisdiction and the VAT facts are
    // established over the API, which is exactly the editing window #215 must
    // preserve.
    await putOrg({
      country: 'EE',
      vat_registered: true,
      vat_registration_number: 'EE100000001',
      registry_code: '17499653',
      name: 'Test OÜ',
    }).expect(200);

    await db.deleteFrom('reporting_period').execute();
    await request(app.getHttpServer())
      .post('/api/reporting-periods')
      .set(auth())
      .send({
        name: PERIOD.name,
        start_date: PERIOD.start,
        end_date: PERIOD.end,
      })
      .expect(201);

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
  });

  afterEach(async () => {
    await app.close();
    await db.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  // ── API helpers (all real HTTP) ─────────────────────────────────────────

  function putOrg(body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .put('/api/organization')
      .set(auth())
      .send(body);
  }

  async function getOrg(): Promise<Record<string, unknown>> {
    const res = await request(app.getHttpServer())
      .get('/api/organization')
      .set(auth())
      .expect(200);
    return res.body as Record<string, unknown>;
  }

  /** A zero-rated EUR 100 sale, posted — the reported transaction. */
  async function postSale(invoiceNumber: string): Promise<void> {
    const res = await request(app.getHttpServer())
      .post('/api/sales-invoices')
      .set(auth())
      .send({
        customer_id: customerId,
        invoice_number: invoiceNumber,
        currency: 'EUR',
        tax_point_date: TAX_POINT,
        gross_amount: 12400,
        vat_amount: 2400,
        supply_type: 'services',
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/sales-invoices/${(res.body as { id: number }).id}/post`)
      .set(auth())
      .send({})
      .expect(201);
  }

  /** AR outstanding straight off the ledger, in base-currency cents. */
  async function arNet(): Promise<number> {
    const row = await db
      .selectFrom('voucher_line as vl')
      .innerJoin('account as a', 'a.id', 'vl.account_id')
      .select((eb) =>
        eb.fn
          .sum<number>(
            eb
              .case()
              .when('vl.is_debit', '=', 1)
              .then(eb.ref('vl.base_amount'))
              .else(eb.neg(eb.ref('vl.base_amount')))
              .end(),
          )
          .as('net'),
      )
      .where('a.code', '=', 'AR')
      .executeTakeFirstOrThrow();
    return Number(row.net ?? 0);
  }

  async function declaration(): Promise<KmdDeclaration> {
    const periods = await request(app.getHttpServer())
      .get('/api/reporting-periods')
      .set(auth())
      .expect(200);
    const { reportingPeriods } = periods.body as {
      reportingPeriods: { id: number; name: string }[];
    };
    const period = reportingPeriods.find((p) => p.name === PERIOD.name);
    if (!period) throw new Error('period not found');
    const res = await request(app.getHttpServer())
      .get(`/api/reporting-periods/${period.id}/kmd`)
      .set(auth())
      .expect(200);
    return res.body as KmdDeclaration;
  }

  // ── the reported sequence ───────────────────────────────────────────────

  it('refuses the base-currency switch after posting, and both sales stay in one basis', async () => {
    await postSale('INV-1');
    expect(await arNet()).toBe(12400);

    const refused = await putOrg({ base_currency: 'USD' }).expect(409);
    expect((refused.body as { message: string }).message).toMatch(
      /measurement basis/i,
    );

    // The organisation did not move.
    expect(await getOrg()).toMatchObject({
      country: 'EE',
      base_currency: null,
      name: 'Test OÜ',
    });

    // So the second sale is measured the same way as the first: 24800, not the
    // reported mixture of two currencies.
    await postSale('INV-2');
    expect(await arNet()).toBe(24800);

    // And the period's declaration reads one basis throughout.
    const d = await declaration();
    expect(d.row1_base_24).toBe(20000);
    expect(d.row4_output_vat).toBe(4800);
  });

  it('refuses a jurisdiction change after posting, on the same terms', async () => {
    await postSale('INV-1');
    await putOrg({ country: 'IE' }).expect(409);
    await putOrg({ country: 'IE', base_currency: 'USD' }).expect(409);
    expect(await getOrg()).toMatchObject({ country: 'EE' });
  });

  // ── what must keep working ──────────────────────────────────────────────

  it('allows the full basis setup while no voucher is posted', async () => {
    await putOrg({ base_currency: 'USD' }).expect(200);
    expect(await getOrg()).toMatchObject({ base_currency: 'USD' });

    await putOrg({ country: 'IE', base_currency: null }).expect(200);
    expect(await getOrg()).toMatchObject({
      country: 'IE',
      base_currency: null,
    });

    // …and back to the jurisdiction the rest of this suite uses.
    await putOrg({ country: 'EE' }).expect(200);
  });

  it('allows a basis edit with no effect, and every unrelated setting, after posting', async () => {
    await postSale('INV-1');

    // EE's plugin default IS EUR, so writing it into the override and clearing
    // it again changes the column but not the measurement.
    await putOrg({ base_currency: 'EUR' }).expect(200);
    await putOrg({ base_currency: null }).expect(200);
    await putOrg({ country: 'EE' }).expect(200);

    await putOrg({
      name: 'Renamed OÜ',
      iban: 'EE382200221020145685',
      vat_registration_number: 'EE100000002',
    }).expect(200);

    // A PUT naming nothing stays the no-op it always was.
    await putOrg({}).expect(200);

    expect(await getOrg()).toMatchObject({
      country: 'EE',
      base_currency: null,
      name: 'Renamed OÜ',
      iban: 'EE382200221020145685',
    });
    expect(await arNet()).toBe(12400);
  });
});
