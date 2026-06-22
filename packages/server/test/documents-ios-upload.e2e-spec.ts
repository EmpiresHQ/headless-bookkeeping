import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Kysely, SqliteDialect } from 'kysely';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import request from 'supertest';
import { createHash } from 'crypto';
import { AppModule } from '../src/app.module';
import { Database } from '../src/database/types';
import { MastraService } from '../src/ai/mastra.service';
import { fauxMastraService } from './faux-mastra.service';

describe('iOS document upload (e2e)', () => {
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
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    token = 'test-token-e2e-12345';
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await db
      .insertInto('api_token')
      .values({ token_hash: tokenHash, label: 'e2e-test' })
      .execute();
  });

  afterEach(async () => app.close());

  it('stores channel, assetLocalId, capturedAt and precheck', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/documents')
      .set('Authorization', `Bearer ${token}`)
      .field('channel', 'ios_photo_library')
      .field('assetLocalId', 'E2E-ASSET-1')
      .field('capturedAt', '2026-06-22T10:00:00.000Z')
      .field('precheck', '{"decision":"upload","top":0.9}')
      .attach('file', Buffer.from('heic-bytes-1'), {
        filename: 'r.heic',
        contentType: 'image/heic',
      })
      .expect(201);

    const docId = res.body.document.id as number;
    const source = await db
      .selectFrom('document_source')
      .selectAll()
      .where('document_id', '=', docId)
      .executeTakeFirstOrThrow();

    expect(source.channel).toBe('ios_photo_library');
    expect(source.source_identifier).toBe('E2E-ASSET-1');
    expect(source.captured_at).toBe(
      Math.floor(Date.parse('2026-06-22T10:00:00.000Z') / 1000),
    );
    expect(source.precheck_json).toBe('{"decision":"upload","top":0.9}');
  });

  it('still accepts a plain file upload with no extra fields', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/documents')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('plain-bytes'), {
        filename: 'plain.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);

    const source = await db
      .selectFrom('document_source')
      .selectAll()
      .where('document_id', '=', res.body.document.id as number)
      .executeTakeFirstOrThrow();
    expect(source.channel).toBe('upload');
    expect(source.captured_at).toBeNull();
    expect(source.precheck_json).toBeNull();
  });

  it('rejects malformed precheck JSON with 400', async () => {
    await request(app.getHttpServer())
      .post('/api/documents')
      .set('Authorization', `Bearer ${token}`)
      .field('precheck', 'not-json')
      .attach('file', Buffer.from('x'), {
        filename: 'x.heic',
        contentType: 'image/heic',
      })
      .expect(400);
  });
});
