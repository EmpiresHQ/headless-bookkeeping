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
import request from 'supertest';
import { App } from 'supertest/types';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

/**
 * Smoke test for the bank-statement import HTTP surface (BANK-T6):
 *   POST /api/bank-statements/import  (multipart CSV upload → jobId)
 *   GET  /api/bank-statements/import/:jobId  (status poll)
 *
 * Boots the full AppModule against an in-memory SQLite DB seeded by the real
 * migrations.  The Mastra service is faux'd (no bank-mapping agent), so the
 * background ingestion throws and the job ends in a terminal state — this test
 * only asserts the HTTP + job plumbing, not the AI result.
 */
describe('Bank import E2E (upload + status)', () => {
  let app: INestApplication<App>;
  let db: Kysely<Database>;
  let root: string;
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

    root = mkdtempSync(join(tmpdir(), 'bank-import-e2e-'));

    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(KYSELY_MODULE_CONNECTION_TOKEN())
      .useValue(db)
      .overrideProvider(DOCUMENT_STORAGE_ROOT)
      .useValue(root)
      .overrideProvider(MastraService)
      .useValue(fauxMastraService)
      .compile();

    app = module.createNestApplication();
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
    await db.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  const csv = 'Date,Amount\n2026-05-01,10.00\n';

  it('uploads a CSV and returns a numeric jobId, then exposes job status', async () => {
    // 1. Upload CSV → 201 + numeric jobId
    const start = await request(app.getHttpServer())
      .post('/api/bank-statements/import')
      .set('Authorization', `Bearer ${apiToken}`)
      .field('account_code', 'BANK_EUR')
      .attach('file', Buffer.from(csv), 'statement.csv')
      .expect(201)
      .then((r) => r.body as { jobId: number });

    expect(typeof start.jobId).toBe('number');
    expect(start.jobId).toBeGreaterThan(0);

    // 2. Poll status → 200 + a job whose status is a string.
    // Under the faux Mastra service there is no bank-mapping agent, so the
    // background ingestion throws and the job is 'running' or 'failed'.
    const job = await request(app.getHttpServer())
      .get(`/api/bank-statements/import/${start.jobId}`)
      .set('Authorization', `Bearer ${apiToken}`)
      .expect(200)
      .then((r) => r.body as { id: number; status: string });

    expect(job.id).toBe(start.jobId);
    expect(typeof job.status).toBe('string');
  });

  it('rejects unauthenticated requests on both routes', async () => {
    await request(app.getHttpServer())
      .post('/api/bank-statements/import')
      .field('account_code', 'BANK_EUR')
      .attach('file', Buffer.from(csv), 'statement.csv')
      .expect(401);

    await request(app.getHttpServer())
      .get('/api/bank-statements/import/1')
      .expect(401);
  });
});
