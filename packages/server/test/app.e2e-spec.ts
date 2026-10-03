import { FX_RATE_SOURCE } from '../src/fx/fx-rate.types';
import { ECB_FIXTURE_RATES, FixtureFxRateSource } from './fx-fixtures';
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

describe('Application (e2e)', () => {
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
      // Issue #203: the FX rate source is the ONE boundary at which
      // authoritative rates enter the system. An e2e test binds it to a
      // deterministic fixture, so booting the app never reaches the ECB.
      .overrideProvider(FX_RATE_SOURCE)
      .useValue(new FixtureFxRateSource(ECB_FIXTURE_RATES))
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    // Seed API token AFTER migrations have run.
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

  it('/health (GET) responds ok', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect((res: { body: { status: string } }) => {
        expect(res.body.status).toBe('ok');
      });
  });

  it('/api/organization (GET) returns the seeded Irish singleton', () => {
    return request(app.getHttpServer())
      .get('/api/organization')
      .set('Authorization', `Bearer ${apiToken}`)
      .expect(200)
      .expect((res: { body: { id: number; country: string } }) => {
        expect(res.body.id).toBe(1);
        expect(res.body.country).toBe('IE');
      });
  });
});
