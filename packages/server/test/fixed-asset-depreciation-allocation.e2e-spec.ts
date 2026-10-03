import { FX_RATE_SOURCE } from '../src/fx/fx-rate.types';
import { ECB_FIXTURE_RATES, FixtureFxRateSource } from './fx-fixtures';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Kysely, SqliteDialect } from 'kysely';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { Database } from '../src/database/types';
import { MastraService } from '../src/ai/mastra.service';
import { fauxMastraService } from './faux-mastra.service';
import { seedApiToken } from './e2e-auth';
import { ZodValidationPipe } from '../src/common/pipes/zod-validation.pipe';
import { PostingService } from '../src/ledger/posting/posting.service';
import { IDENTITY_RATE_SOURCE } from '../src/fx/fx-rate.types';
import type { DraftVoucher } from '../src/ledger/voucher/types';

/**
 * The OPERATOR-FACING recovery path for unattributed depreciation (issue
 * #208), over real HTTP.
 *
 * When some posted depreciation cannot be tied to individual assets — a close
 * from before migration 075, or a charge someone booked by hand — the kernel
 * refuses to guess: the asset's disposal is refused and the year cannot be
 * finalized. This suite drives the way out end to end through the API:
 * list what is unattributed, allocate it, and then dispose.
 *
 * It exercises what a service-level test cannot: route ordering against the
 * `:id` parameter routes, DTO validation and the actual HTTP status codes.
 */
describe('Fixed-asset depreciation allocation (e2e)', () => {
  let app: INestApplication<App>;
  let db: Kysely<Database>;
  let token: string;
  let posting: PostingService;

  function draft(
    taxPointDate: string,
    lines: Array<{ code: string; isDebit: boolean; base: number }>,
    reason?: string,
  ): DraftVoucher {
    return {
      tax_point_date: taxPointDate,
      reason,
      lines: lines.map((l) => ({
        account_code: l.code,
        is_debit: l.isDebit,
        amount: l.base,
        currency: 'EUR',
        base_amount: l.base,
        fx_rate: 1,
        fx_rate_source: IDENTITY_RATE_SOURCE,
        vat_code: null,
      })),
    };
  }

  async function registerAsset(name: string): Promise<number> {
    const acq = await posting.postVoucher(
      draft('2026-01-01', [
        { code: 'FIXED_ASSETS_IT', isDebit: true, base: 120000 },
        { code: 'BANK_EUR', isDebit: false, base: 120000 },
      ]),
    );
    const row = await db
      .insertInto('fixed_asset')
      .values({
        name,
        asset_class: 'it_equipment',
        acquisition_voucher_id: acq.id,
        acquisition_date: '2026-01-01',
        cost_base_minor: 120000,
        useful_life_years: 4,
        residual_value_minor: 0,
        retired_at: null,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id as number;
  }

  beforeEach(async () => {
    const rawDb = new SqliteDb(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: rawDb }),
    });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(KYSELY_MODULE_CONNECTION_TOKEN())
      .useValue(db)
      .overrideProvider(MastraService)
      .useValue(fauxMastraService)
      .overrideProvider(FX_RATE_SOURCE)
      .useValue(new FixtureFxRateSource(ECB_FIXTURE_RATES))
      .compile();

    app = moduleFixture.createNestApplication();
    // The same global pipe bootstrap installs (main.ts), so the DTO schemas
    // are enforced here exactly as they are in production.
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();
    token = await seedApiToken(db);
    posting = moduleFixture.get(PostingService);
  });

  afterEach(async () => {
    await app.close();
  });

  it('lists an unattributed charge, allocates it, and only then allows disposal', async () => {
    const a = await registerAsset('Laptop A');
    const b = await registerAsset('Laptop B');
    const manual = await posting.postVoucher(
      draft(
        '2026-06-30',
        [
          { code: 'DEPRECIATION_EXPENSE', isDebit: true, base: 20000 },
          { code: 'ACCUM_DEPRECIATION_IT', isDebit: false, base: 20000 },
        ],
        'Depreciation booked by hand',
      ),
    );

    // 1. The register reports the ambiguity beside the book values rather than
    //    quietly netting a peer's depreciation off each card.
    const listed = await request(app.getHttpServer())
      .get('/api/fixed-assets')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(
      (
        listed.body as {
          fixedAssets: Array<{ unattributed_depreciation_minor: number }>;
        }
      ).fixedAssets.map((r) => r.unattributed_depreciation_minor),
    ).toEqual([20000, 20000]);

    // 2. The queue of what has to be resolved. This route sits beside
    //    `/:id/disposal`, so reaching it at all proves the literal path is not
    //    swallowed by the `:id` parameter route.
    const queue = await request(app.getHttpServer())
      .get('/api/fixed-assets/unattributed-depreciation')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(
      (queue.body as { unattributed: Array<Record<string, unknown>> })
        .unattributed,
    ).toHaveLength(1);
    expect(
      (queue.body as { unattributed: Array<Record<string, unknown>> })
        .unattributed[0],
    ).toMatchObject({
      voucherId: manual.id,
      assetClass: 'it_equipment',
      unattributedMinor: 20000,
      cause: 'unattributed_posting',
    });

    // 3. Disposal is refused, actionably: 400 naming the voucher and the route.
    const refused = await request(app.getHttpServer())
      .post(`/api/fixed-assets/${a}/disposal`)
      .set('Authorization', `Bearer ${token}`)
      .send({ disposal_date: '2027-06-30' })
      .expect(400);
    expect(refused.body).toMatchObject({
      error: 'depreciation_attribution_required',
      fixedAssetId: a,
    });
    expect(
      (refused.body as { unattributed: Array<{ voucherId: number }> })
        .unattributed[0].voucherId,
    ).toBe(manual.id);

    // 4. An allocation that does not reconcile is refused with 400.
    await request(app.getHttpServer())
      .post('/api/fixed-assets/depreciation-allocations')
      .set('Authorization', `Bearer ${token}`)
      .send({
        voucher_id: manual.id,
        allocations: [{ fixed_asset_id: a, amount_minor: 10000 }],
      })
      .expect(400);

    // 5. The real split is accepted.
    const ok = await request(app.getHttpServer())
      .post('/api/fixed-assets/depreciation-allocations')
      .set('Authorization', `Bearer ${token}`)
      .send({
        voucher_id: manual.id,
        allocations: [
          { fixed_asset_id: a, amount_minor: 10000 },
          { fixed_asset_id: b, amount_minor: 10000 },
        ],
      })
      .expect(201);
    expect(ok.body).toEqual({ written: 2 });

    // 6. Repeating it is refused — the rows are append-only.
    await request(app.getHttpServer())
      .post('/api/fixed-assets/depreciation-allocations')
      .set('Authorization', `Bearer ${token}`)
      .send({
        voucher_id: manual.id,
        allocations: [
          { fixed_asset_id: a, amount_minor: 10000 },
          { fixed_asset_id: b, amount_minor: 10000 },
        ],
      })
      .expect(400);

    // 7. The queue is empty and the cards reconcile to the class control
    //    balance (240000 cost − 20000 contra).
    const clean = await request(app.getHttpServer())
      .get('/api/fixed-assets/unattributed-depreciation')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect((clean.body as { unattributed: unknown[] }).unattributed).toEqual(
      [],
    );
    const relisted = await request(app.getHttpServer())
      .get('/api/fixed-assets')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const cards = (
      relisted.body as {
        fixedAssets: Array<{ book_value_minor: number }>;
      }
    ).fixedAssets;
    expect(cards.map((c) => c.book_value_minor)).toEqual([110000, 110000]);
    expect(cards.reduce((s, c) => s + c.book_value_minor, 0)).toBe(220000);

    // 8. And the disposal now goes through.
    await request(app.getHttpServer())
      .post(`/api/fixed-assets/${a}/disposal`)
      .set('Authorization', `Bearer ${token}`)
      .send({ disposal_date: '2027-06-30' })
      .expect(201);
  });

  it('rejects a malformed allocation payload with 400', async () => {
    const a = await registerAsset('Laptop A');
    const manual = await posting.postVoucher(
      draft('2026-06-30', [
        { code: 'DEPRECIATION_EXPENSE', isDebit: true, base: 10000 },
        { code: 'ACCUM_DEPRECIATION_IT', isDebit: false, base: 10000 },
      ]),
    );

    for (const body of [
      {}, // no voucher
      { voucher_id: manual.id }, // no allocations
      { voucher_id: manual.id, allocations: [] }, // empty
      { voucher_id: manual.id, allocations: [{ fixed_asset_id: a }] }, // no amount
      {
        voucher_id: manual.id,
        allocations: [{ fixed_asset_id: a, amount_minor: 100.5 }],
      }, // not minor units
      {
        voucher_id: manual.id,
        allocations: [{ fixed_asset_id: -1, amount_minor: 10000 }],
      }, // not an asset id
    ]) {
      const res = await request(app.getHttpServer())
        .post('/api/fixed-assets/depreciation-allocations')
        .set('Authorization', `Bearer ${token}`)
        .send(body);
      expect(res.status).toBe(400);
    }

    // An unknown voucher is a 400 too, not a 500.
    await request(app.getHttpServer())
      .post('/api/fixed-assets/depreciation-allocations')
      .set('Authorization', `Bearer ${token}`)
      .send({
        voucher_id: 999999,
        allocations: [{ fixed_asset_id: a, amount_minor: 10000 }],
      })
      .expect(400);
  });

  it('requires a token on both new routes', async () => {
    await request(app.getHttpServer())
      .get('/api/fixed-assets/unattributed-depreciation')
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/fixed-assets/depreciation-allocations')
      .send({ voucher_id: 1, allocations: [] })
      .expect(401);
  });

  it('rejects a disposal date that is not a real calendar day with 400', async () => {
    const a = await registerAsset('Laptop A');
    for (const bad of ['2027-02-30', '2027-13-01', 'yesterday']) {
      await request(app.getHttpServer())
        .post(`/api/fixed-assets/${a}/disposal`)
        .set('Authorization', `Bearer ${token}`)
        .send({ disposal_date: bad })
        .expect(400);
    }
  });
});
