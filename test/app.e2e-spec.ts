import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Kysely, SqliteDialect } from 'kysely';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

/**
 * Full-graph smoke test: boots the real AppModule (including the migration
 * runner) against an in-memory SQLite DB, then exercises the public endpoints.
 */
describe('Application (e2e)', () => {
  let app: INestApplication<App>;
  let db: Kysely<unknown>;

  beforeEach(async () => {
    db = new Kysely<unknown>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(KYSELY_MODULE_CONNECTION_TOKEN())
      .useValue(db)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init(); // runs the migration runner -> seeds the Irish org
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

  it('/api/organization (GET) returns the seeded Irish singleton with no currency override', () => {
    return request(app.getHttpServer())
      .get('/api/organization')
      .expect(200)
      .expect(
        (res: {
          body: { id: number; country: string; base_currency: string | null };
        }) => {
          expect(res.body.id).toBe(1);
          expect(res.body.country).toBe('IE');
          expect(res.body.base_currency).toBeNull();
        },
      );
  });
});
