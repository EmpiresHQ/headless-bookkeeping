import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Kysely, SqliteDialect } from 'kysely';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { Database } from './../src/database/types';
import { MastraService } from './../src/ai/mastra.service';
import { fauxMastraService } from './faux-mastra.service';
import { createHash } from 'crypto';

describe('DB constraint → 4xx (e2e)', () => {
  let app: INestApplication<App>;
  let db: Kysely<Database>;
  let apiToken: string;

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
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    apiToken = 'test-token-e2e-12345';
    const tokenHash = createHash('sha256').update(apiToken).digest('hex');
    await db
      .insertInto('api_token')
      .values({ token_hash: tokenHash, label: 'e2e-test' })
      .execute();
  });

  afterEach(async () => {
    await app.close();
  });

  const validExpense = {
    category: 'software',
    gross_amount: 12300,
    vat_amount: 2300,
    currency: 'EUR',
    tax_point_date: '2026-06-09',
  };

  it('a non-existent supplier_id (FK violation) → 400, not 500', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/expenses')
      .set('Authorization', `Bearer ${apiToken}`)
      .send({ ...validExpense, supplier_id: 999999 })
      .expect(400);
    expect((res.body as { constraint?: string }).constraint).toContain(
      'FOREIGNKEY',
    );
  });

  it('a valid expense without FK references still creates (201)', async () => {
    await request(app.getHttpServer())
      .post('/api/expenses')
      .set('Authorization', `Bearer ${apiToken}`)
      .send(validExpense)
      .expect(201);
  });
});
