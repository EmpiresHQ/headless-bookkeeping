import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import request from 'supertest';
import { App } from 'supertest/types';
import { createHash } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from '../src/database/types';
import { migrations } from '../src/database/migrations';
import { AppModule } from '../src/app.module';
import { MastraService } from '../src/ai/mastra.service';
import { fauxMastraService } from './faux-mastra.service';
import { DOCUMENT_STORAGE_ROOT } from '../src/documents/document-storage.service';
import { ZodValidationPipe } from '../src/common/pipes/zod-validation.pipe';
import { FX_RATE_SOURCE } from '../src/fx/fx-rate.types';
import { FixtureFxRateSource } from './fx-fixtures';

/**
 * Issue #203 over real HTTP, through the real global filter.
 *
 * A missing reference rate is an expected domain outcome. As a plain Error it
 * fell through the catch-all filter as `500 {"message":"Internal server
 * error"}` — which named neither the pair, nor the date, nor whether retrying
 * would help. These tests pin the structured failure instead, and pin that
 * nothing reaches the ledger on the way out.
 */
describe('FX rate unavailable over HTTP (e2e)', () => {
  let app: INestApplication<App>;
  let db: Kysely<Database>;
  let root: string;
  let token: string;
  let source: FixtureFxRateSource;

  // Quotes USD, published only on Friday 2026-03-06.
  const RATES = [{ quoteCurrency: 'USD', rateDate: '2026-03-06', rate: 1.25 }];

  const seedExpense = async (currency: string, taxPointDate: string) => {
    const res = await request(app.getHttpServer())
      .post('/api/expenses')
      .set('Authorization', `Bearer ${token}`)
      .send({
        category: 'software',
        gross_amount: 10000,
        vat_amount: 0,
        currency,
        tax_point_date: taxPointDate,
      })
      .expect(201);
    return (res.body as { id: number }).id;
  };

  beforeEach(async () => {
    const rawDb = new SqliteDb(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: rawDb }),
    });
    const { error } = await new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    }).migrateToLatest();
    if (error) {
      throw error instanceof Error ? error : new Error('Migration failed');
    }
    // The deployment the issue was reported against.
    await db
      .updateTable('organization')
      .set({ country: 'EE', base_currency: null })
      .execute();
    await db
      .insertInto('policy_config')
      .values({ key: 'auto_post_enabled', value: 'true', updated_at: 0 })
      .execute();
    root = mkdtempSync(join(tmpdir(), 'fx-unavailable-e2e-'));

    source = new FixtureFxRateSource(RATES, 'ECB', ['USD']);
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
      .useValue(source)
      .compile();

    app = module.createNestApplication();
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();

    token = 'test-token-e2e-12345';
    await db
      .insertInto('api_token')
      .values({
        token_hash: createHash('sha256').update(token).digest('hex'),
        label: 'e2e-test',
      })
      .execute();
  });

  afterEach(async () => {
    await app?.close();
    await db?.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  it('answers 422 with the pair, the date and a stable code — not an opaque 500', async () => {
    // 2026-03-02 precedes every publication the authority has.
    const id = await seedExpense('USD', '2026-03-02');

    const res = await request(app.getHttpServer())
      .post(`/api/expenses/${id}/post`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      statusCode: 422,
      code: 'FX_RATE_UNAVAILABLE',
      reason: 'no_rate_for_date',
      fromCurrency: 'USD',
      toCurrency: 'EUR',
      date: '2026-03-02',
      retryable: false,
    });
    expect(res.body).not.toMatchObject({ message: 'Internal server error' });
  });

  it('posts NOTHING on the way out — no voucher, expense still draft', async () => {
    const id = await seedExpense('USD', '2026-03-02');

    await request(app.getHttpServer())
      .post(`/api/expenses/${id}/post`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(422);

    expect(await db.selectFrom('voucher').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('voucher_line').selectAll().execute()).toEqual(
      [],
    );
    const expense = await db
      .selectFrom('expense')
      .select(['status', 'voucher_id'])
      .executeTakeFirstOrThrow();
    expect(expense).toEqual({ status: 'draft', voucher_id: null });
  });

  it('the draft-generation route refuses the same way', async () => {
    const id = await seedExpense('USD', '2026-03-02');

    const res = await request(app.getHttpServer())
      .post(`/api/expenses/${id}/generate-draft`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'FX_RATE_UNAVAILABLE' });
  });

  it('a currency the authority does not quote is 422 unsupported_pair', async () => {
    const id = await seedExpense('JPY', '2026-03-06');

    const res = await request(app.getHttpServer())
      .post(`/api/expenses/${id}/post`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      reason: 'unsupported_pair',
      retryable: false,
    });
  });

  it('an upstream outage is 503 and says it is worth retrying', async () => {
    const id = await seedExpense('USD', '2026-03-06');
    source.setFailure('ECB responded 503');

    const res = await request(app.getHttpServer())
      .post(`/api/expenses/${id}/post`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      code: 'FX_RATE_UNAVAILABLE',
      reason: 'upstream_unavailable',
      retryable: true,
    });
    expect(await db.selectFrom('voucher').selectAll().execute()).toEqual([]);
  });

  it('and once the source is reachable again, the same request posts', async () => {
    const id = await seedExpense('USD', '2026-03-06');
    source.setFailure('ECB responded 503');
    await request(app.getHttpServer())
      .post(`/api/expenses/${id}/post`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(503);

    source.setFailure(null);
    await request(app.getHttpServer())
      .post(`/api/expenses/${id}/post`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(201);

    const lines = await db
      .selectFrom('voucher_line')
      .select(['fx_rate_date', 'fx_rate_source'])
      .execute();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toEqual({
        fx_rate_date: '2026-03-06',
        fx_rate_source: 'ECB',
      });
    }
  });
});
