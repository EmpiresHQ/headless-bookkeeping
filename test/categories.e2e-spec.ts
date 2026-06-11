import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../src/database/types';
import { migrations } from '../src/database/migrations';
import { AppModule } from '../src/app.module';
import { MastraService } from '../src/ai/mastra.service';
import { fauxMastraService } from './faux-mastra.service';
import { DOCUMENT_STORAGE_ROOT } from '../src/documents/document-storage.service';
import { ApiTokenService } from '../src/auth/api-token.service';
import request from 'supertest';
import { App } from 'supertest/types';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('GET /api/categories (e2e)', () => {
  let app: INestApplication<App>;
  let db: Kysely<Database>;
  let root: string;
  let bearerToken: string;

  beforeAll(async () => {
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

    root = mkdtempSync(join(tmpdir(), 'categories-e2e-'));

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(KYSELY_MODULE_CONNECTION_TOKEN())
      .useValue(db)
      .overrideProvider(DOCUMENT_STORAGE_ROOT)
      .useValue(root)
      .overrideProvider(MastraService)
      .useValue(fauxMastraService)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    const created = await app.get(ApiTokenService).create('e2e-categories');
    bearerToken = created.token;
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  it('GET /api/categories returns the active plugin category set', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/categories')
      .set('Authorization', `Bearer ${bearerToken}`)
      .expect(200);

    const body = res.body as { categories: { key: string; label: string; accountCode: string }[] };
    expect(Array.isArray(body.categories)).toBe(true);
    expect(body.categories.length).toBeGreaterThan(0);
    expect(body.categories.map((c) => c.key)).toContain('software');
    expect(body.categories.find((c) => c.key === 'software')?.accountCode).toBe(
      'EXPENSE_SOFTWARE',
    );
  });

  it('GET /api/categories returns 401 when Authorization header is absent', async () => {
    await request(app.getHttpServer()).get('/api/categories').expect(401);
  });
});
