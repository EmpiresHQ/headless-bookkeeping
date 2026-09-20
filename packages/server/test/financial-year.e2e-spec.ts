import { FX_RATE_SOURCE } from '../src/fx/fx-rate.types';
import { ECB_FIXTURE_RATES, FixtureFxRateSource } from './fx-fixtures';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import request from 'supertest';
import { App } from 'supertest/types';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from '../src/database/types';
import { migrations } from '../src/database/migrations';
import { AppModule } from '../src/app.module';
import { MastraService } from '../src/ai/mastra.service';
import { fauxMastraService } from './faux-mastra.service';
import { DOCUMENT_STORAGE_ROOT } from '../src/documents/document-storage.service';
import { OrganizationService } from '../src/organization/organization.service';
import { seedApiToken } from './e2e-auth';

/**
 * Issue #207 over HTTP: the financial-year scope as an API client sees it, and
 * the two things a client must NOT be able to do — file a year as if it were a
 * VAT return, or hand itself the trusted year-end-adjustment mark.
 */
describe('Financial years over HTTP (e2e)', () => {
  let app: INestApplication<App>;
  let db: Kysely<Database>;
  let root: string;
  let token: string;

  const api = (): request.Agent => request(app.getHttpServer());
  const bearer = (): string => `Bearer ${token}`;

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

    root = mkdtempSync(join(tmpdir(), 'financial-year-e2e-'));
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
    token = await seedApiToken(db);

    await app.get(OrganizationService).updateOrganization({
      country: 'EE',
      vat_registered: true,
      vat_registration_number: 'EE100000001',
      registry_code: '17499653',
      name: 'Test OÜ',
    });

    // Migration 011 seeds a stray 2024-Q1 period; each test builds its own.
    await db.deleteFrom('reporting_period').execute();
  });

  afterEach(async () => {
    await app.close();
    await db.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  async function createPeriod(
    name: string,
    start: string,
    end: string,
    kind?: 'vat' | 'annual',
  ): Promise<number> {
    const res = await api()
      .post('/api/reporting-periods')
      .set('Authorization', bearer())
      .send({
        name,
        start_date: start,
        end_date: end,
        ...(kind ? { kind } : {}),
      })
      .expect(201);
    return res.body.id as number;
  }

  it('creates a financial year alongside twelve monthly VAT periods and lists each timeline', async () => {
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0');
      const last = new Date(Date.UTC(2026, m, 0)).toISOString().slice(8, 10);
      await createPeriod(`2026-${mm}`, `2026-${mm}-01`, `2026-${mm}-${last}`);
    }
    const fyId = await createPeriod(
      'FY2026',
      '2026-01-01',
      '2026-12-31',
      'annual',
    );

    // The default listing is the VAT calendar: the year is not one of its rows.
    const vatList = await api()
      .get('/api/reporting-periods')
      .set('Authorization', bearer())
      .expect(200);
    expect(vatList.body.reportingPeriods).toHaveLength(12);
    expect(
      vatList.body.reportingPeriods.every(
        (p: { kind: string }) => p.kind === 'vat',
      ),
    ).toBe(true);

    const annualList = await api()
      .get('/api/reporting-periods?kind=annual')
      .set('Authorization', bearer())
      .expect(200);
    expect(annualList.body.reportingPeriods).toEqual([
      expect.objectContaining({ id: fyId, name: 'FY2026', kind: 'annual' }),
    ]);

    const all = await api()
      .get('/api/reporting-periods?kind=all')
      .set('Authorization', bearer())
      .expect(200);
    expect(all.body.reportingPeriods).toHaveLength(13);

    await api()
      .get('/api/reporting-periods?kind=quarterly')
      .set('Authorization', bearer())
      .expect(400);

    // Overlap is still rejected within each timeline.
    await api()
      .post('/api/reporting-periods')
      .set('Authorization', bearer())
      .send({
        name: '2026-03b',
        start_date: '2026-03-10',
        end_date: '2026-03-20',
      })
      .expect(409);
    await api()
      .post('/api/reporting-periods')
      .set('Authorization', bearer())
      .send({
        name: 'FY2026b',
        start_date: '2026-06-01',
        end_date: '2027-05-31',
        kind: 'annual',
      })
      .expect(409);
  });

  it('refuses to file a financial year as a VAT return, through every filing route', async () => {
    const fyId = await createPeriod(
      'FY2026',
      '2026-01-01',
      '2026-12-31',
      'annual',
    );

    await api()
      .post(`/api/reporting-periods/${fyId}/lock`)
      .set('Authorization', bearer())
      .expect(409);
    await api()
      .get(`/api/reporting-periods/${fyId}/kmd`)
      .set('Authorization', bearer())
      .expect(409);
    await api()
      .get(`/api/reporting-periods/${fyId}/statutory-report?format=xml`)
      .set('Authorization', bearer())
      .expect(409);
    await api()
      .post(`/api/reporting-periods/${fyId}/filing/reconcile`)
      .set('Authorization', bearer())
      .expect(409);

    expect(
      await db.selectFrom('vat_report').selectAll().execute(),
    ).toHaveLength(0);
    expect(
      await db.selectFrom('statutory_submission_event').selectAll().execute(),
    ).toHaveLength(0);
  });

  it('gives no HTTP client a way to mark a voucher as a year-end adjustment', async () => {
    const janId = await createPeriod('2026-01', '2026-01-01', '2026-01-31');
    await createPeriod('FY2026', '2026-01-01', '2026-12-31', 'annual');

    const body = (date: string): Record<string, unknown> => ({
      tax_point_date: date,
      lines: [
        {
          account_code: 'DEPRECIATION_EXPENSE',
          amount: 100,
          currency: 'EUR',
          base_amount: 100,
          fx_rate: 1,
          is_debit: true,
        },
        {
          account_code: 'ACCUM_DEPRECIATION_VEHICLES',
          amount: 100,
          currency: 'EUR',
          base_amount: 100,
          fx_rate: 1,
          is_debit: false,
        },
      ],
    });

    // An ordinary post into an OPEN month succeeds — and carries no mark, even
    // though the payload asked for one and named a real financial year.
    const ok = await api()
      .post('/api/vouchers')
      .set('Authorization', bearer())
      .send({
        ...body('2026-01-20'),
        annual_close_period_id: 1,
        semantics: 'annual-close',
      })
      .expect(201);
    const row = await db
      .selectFrom('voucher')
      .selectAll()
      .where('id', '=', ok.body.id as number)
      .executeTakeFirstOrThrow();
    expect(row.annual_close_period_id).toBeNull();

    // File January, then try again: the same payload is now simply rejected by
    // the locked-period rule. The claim buys nothing.
    await api()
      .post(`/api/reporting-periods/${janId}/lock`)
      .set('Authorization', bearer())
      .expect(201);
    await api()
      .post('/api/vouchers')
      .set('Authorization', bearer())
      .send({
        ...body('2026-01-21'),
        annual_close_period_id: 1,
        semantics: 'annual-close',
      })
      .expect(400);
  });

  it('finalizes the year over filed months and leaves the filed December snapshot untouched', async () => {
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0');
      const last = new Date(Date.UTC(2026, m, 0)).toISOString().slice(8, 10);
      await createPeriod(`2026-${mm}`, `2026-${mm}-01`, `2026-${mm}-${last}`);
    }
    const fyId = await createPeriod(
      'FY2026',
      '2026-01-01',
      '2026-12-31',
      'annual',
    );

    // Some 2026 trading, and a capitalized van, posted through the API.
    await api()
      .post('/api/vouchers')
      .set('Authorization', bearer())
      .send({
        tax_point_date: '2026-02-01',
        lines: [
          {
            account_code: 'BANK_EUR',
            amount: 50000,
            currency: 'EUR',
            base_amount: 50000,
            fx_rate: 1,
            is_debit: true,
          },
          {
            account_code: 'EQUITY',
            amount: 50000,
            currency: 'EUR',
            base_amount: 50000,
            fx_rate: 1,
            is_debit: false,
          },
        ],
      })
      .expect(201);
    const acq = await api()
      .post('/api/vouchers')
      .set('Authorization', bearer())
      .send({
        tax_point_date: '2026-02-02',
        lines: [
          {
            account_code: 'FIXED_ASSETS_VEHICLES',
            amount: 20000,
            currency: 'EUR',
            base_amount: 20000,
            fx_rate: 1,
            is_debit: true,
          },
          {
            account_code: 'BANK_EUR',
            amount: 20000,
            currency: 'EUR',
            base_amount: 20000,
            fx_rate: 1,
            is_debit: false,
          },
        ],
      })
      .expect(201);
    await db
      .insertInto('fixed_asset')
      .values({
        name: 'Van',
        asset_class: 'vehicle',
        acquisition_voucher_id: acq.body.id as number,
        acquisition_date: '2026-02-02',
        cost_base_minor: 20000,
        useful_life_years: 5,
        residual_value_minor: 0,
        retired_at: null,
      } as never)
      .execute();

    // File every month of 2026.
    const vatPeriods = await db
      .selectFrom('reporting_period')
      .select(['id', 'name'])
      .where('kind', '=', 'vat')
      .orderBy('start_date', 'asc')
      .execute();
    for (const p of vatPeriods) {
      await api()
        .post(`/api/reporting-periods/${p.id}/lock`)
        .set('Authorization', bearer())
        .expect(201);
    }
    const snapshotsBefore = await db
      .selectFrom('vat_report')
      .selectAll()
      .orderBy('id', 'asc')
      .execute();

    // The draft is readable while the year is open…
    await api()
      .get(`/api/reporting-periods/${fyId}/annual-accounts`)
      .set('Authorization', bearer())
      .expect(200);

    // …and the year closes, though December was filed months ago.
    const finalized = await api()
      .post(`/api/reporting-periods/${fyId}/annual-accounts/finalize`)
      .set('Authorization', bearer())
      .send({ confirm: true })
      .expect(201);
    expect(finalized.body.artifacts).toHaveLength(1);

    expect(
      await db
        .selectFrom('vat_report')
        .selectAll()
        .orderBy('id', 'asc')
        .execute(),
    ).toEqual(snapshotsBefore);

    const fy = await api()
      .get(`/api/reporting-periods/${fyId}`)
      .set('Authorization', bearer())
      .expect(200);
    expect(fy.body).toMatchObject({
      kind: 'annual',
      status: 'locked',
      vat_report_snapshot_id: null,
    });

    // December's export still reproduces its filing, with no drift.
    const dec = vatPeriods.find((p) => p.name === '2026-12')!;
    const decExport = await api()
      .get(`/api/reporting-periods/${dec.id}/statutory-report?format=xml`)
      .set('Authorization', bearer())
      .expect(200);
    expect(JSON.stringify(decExport.body)).not.toContain(
      'filing_snapshot_drift',
    );

    // And the closed year is sealed: nothing posts into it any more.
    await api()
      .post('/api/vouchers')
      .set('Authorization', bearer())
      .send({
        tax_point_date: '2026-07-01',
        lines: [
          {
            account_code: 'EXPENSE_OTHER',
            amount: 100,
            currency: 'EUR',
            base_amount: 100,
            fx_rate: 1,
            is_debit: true,
          },
          {
            account_code: 'BANK_EUR',
            amount: 100,
            currency: 'EUR',
            base_amount: 100,
            fx_rate: 1,
            is_debit: false,
          },
        ],
      })
      .expect(400);

    // A second finalize is refused.
    await api()
      .post(`/api/reporting-periods/${fyId}/annual-accounts/finalize`)
      .set('Authorization', bearer())
      .send({ confirm: true })
      .expect(409);
  });
});
