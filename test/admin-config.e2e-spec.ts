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
import { ZodValidationPipe } from '../src/common/pipes/zod-validation.pipe';
import request from 'supertest';
import { App } from 'supertest/types';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * End-to-end tests for the admin config HTTP API:
 *   - Settings CRUD (admin/settings)
 *   - Token management (admin/tokens)
 *
 * Boots the full AppModule against an in-memory SQLite DB seeded by the
 * real migrations, with a temp directory for document storage.
 * Exercises the HTTP layer via supertest with a Bearer token obtained
 * from ApiTokenService.create() after app initialisation.
 */
describe('Admin Config HTTP API (e2e)', () => {
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

    root = mkdtempSync(join(tmpdir(), 'admin-config-e2e-'));

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
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();

    // Obtain a Bearer token via the service directly — plaintext returned once.
    const created = await app.get(ApiTokenService).create('e2e');
    bearerToken = created.token;
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  // ── settings CRUD ─────────────────────────────────────────────────

  describe('PUT /admin/settings/:key', () => {
    it('writes a known key and returns 200 with the stored value', async () => {
      const res = await request(app.getHttpServer())
        .put('/admin/settings/ai_model')
        .set('Authorization', `Bearer ${bearerToken}`)
        .send({ value: 'openai/gpt-4o' })
        .expect(200);

      expect(res.body).toMatchObject({
        key: 'ai_model',
        value: 'openai/gpt-4o',
      });
    });

    it('returns 401 when Authorization header is absent', async () => {
      await request(app.getHttpServer())
        .put('/admin/settings/ai_model')
        .send({ value: 'openai/gpt-4o' })
        .expect(401);
    });

    it('returns 400 for an unknown key', async () => {
      await request(app.getHttpServer())
        .put('/admin/settings/not_a_key')
        .set('Authorization', `Bearer ${bearerToken}`)
        .send({ value: 'x' })
        .expect(400);
    });
  });

  describe('GET /admin/settings/:key', () => {
    it('returns the stored value for a previously written key', async () => {
      // Ensure the key is set first.
      await request(app.getHttpServer())
        .put('/admin/settings/ai_model')
        .set('Authorization', `Bearer ${bearerToken}`)
        .send({ value: 'openai/gpt-4o' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .get('/admin/settings/ai_model')
        .set('Authorization', `Bearer ${bearerToken}`)
        .expect(200);

      expect(res.body).toMatchObject({
        key: 'ai_model',
        value: 'openai/gpt-4o',
      });
    });
  });

  // ── token management ──────────────────────────────────────────────

  describe('POST /admin/tokens', () => {
    it('creates a token and returns 201 with id and plaintext token', async () => {
      const res = await request(app.getHttpServer())
        .post('/admin/tokens')
        .set('Authorization', `Bearer ${bearerToken}`)
        .send({ label: 'x' })
        .expect(201);

      const body = res.body as { id: number; token: string };
      expect(body.id).toBeGreaterThan(0);
      expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('GET /admin/tokens', () => {
    it('lists token metadata and does not include plaintext tokens', async () => {
      const created = await request(app.getHttpServer())
        .post('/admin/tokens')
        .set('Authorization', `Bearer ${bearerToken}`)
        .send({ label: 'list-test' })
        .expect(201)
        .then((r) => r.body as { id: number; token: string });

      const res = await request(app.getHttpServer())
        .get('/admin/tokens')
        .set('Authorization', `Bearer ${bearerToken}`)
        .expect(200);

      const body2 = res.body as { tokens: { id: number; label: string }[] };
      const tokens = body2.tokens;
      expect(
        tokens.some((t) => t.id === created.id && t.label === 'list-test'),
      ).toBe(true);

      // Plaintext must never appear in the list response.
      expect(JSON.stringify(tokens)).not.toContain(created.token);
    });
  });

  describe('DELETE /admin/tokens/:id', () => {
    it('revokes a token and returns 200', async () => {
      const created = await request(app.getHttpServer())
        .post('/admin/tokens')
        .set('Authorization', `Bearer ${bearerToken}`)
        .send({ label: 'to-revoke' })
        .expect(201)
        .then((r) => r.body as { id: number; token: string });

      const res = await request(app.getHttpServer())
        .delete(`/admin/tokens/${created.id}`)
        .set('Authorization', `Bearer ${bearerToken}`)
        .expect(200);

      expect(res.body).toMatchObject({ id: created.id, revoked: true });
    });
  });
});
