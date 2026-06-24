/**
 * E2E: GET /api/documents/:id/preview — wire-level header assertions (Gap 1).
 *
 * Tests that the controller correctly sets:
 *   - Content-Type: image/png
 *   - ETag: "<hash>" (quoted document hash)
 *
 * DocumentsService is replaced by a minimal stub so the test stays fast and
 * does not require a real filesystem or renderer.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Kysely, SqliteDialect } from 'kysely';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { NotFoundException } from '@nestjs/common';
import request from 'supertest';
import { createHash } from 'crypto';
import { AppModule } from '../src/app.module';
import { Database } from '../src/database/types';
import { MastraService } from '../src/ai/mastra.service';
import { DocumentsService } from '../src/documents/documents.service';
import { fauxMastraService } from './faux-mastra.service';

const FIXED_HASH = 'deadbeefdeadbeefdeadbeefdeadbeef';
const FIXED_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic bytes

describe('GET /api/documents/:id/preview — HTTP headers (e2e)', () => {
  let app: INestApplication;
  let db: Kysely<Database>;
  let token: string;

  beforeEach(async () => {
    const rawDb = new SqliteDb(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: rawDb }),
    });

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(KYSELY_MODULE_CONNECTION_TOKEN())
      .useValue(db)
      .overrideProvider(MastraService)
      .useValue(fauxMastraService)
      .overrideProvider(DocumentsService)
      .useValue({
        getPreview: jest.fn().mockImplementation(async (id: number) => {
          if (id === 1) return { buffer: FIXED_PNG, hash: FIXED_HASH };
          throw new NotFoundException(`Document ${id} not found`);
        }),
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    token = 'preview-e2e-token';
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await db
      .insertInto('api_token')
      .values({ token_hash: tokenHash, label: 'preview-e2e' })
      .execute();
  });

  afterEach(async () => app.close());

  it('returns Content-Type: image/png and a quoted ETag equal to the document hash', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/documents/1/preview')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.headers['content-type']).toMatch(/^image\/png/);
    expect(res.headers['etag']).toBe(`"${FIXED_HASH}"`);
  });

  it('returns 404 for an unknown document id', async () => {
    await request(app.getHttpServer())
      .get('/api/documents/9999/preview')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });
});
