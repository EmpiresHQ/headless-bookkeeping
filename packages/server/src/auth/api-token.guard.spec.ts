import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, Controller, Get, Post } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import request from 'supertest';
import type { Response } from 'supertest';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { ApiTokenService } from './api-token.service';
import { ApiTokenGuard, Public, EnrollmentOnly } from './api-token.guard';

/**
 * Minimal test controller with one protected and one public route.
 */
@Controller('test')
class TestController {
  @Get('protected')
  getProtected(): { ok: boolean } {
    return { ok: true };
  }

  @Public()
  @Get('public')
  getPublic(): { ok: boolean } {
    return { ok: true };
  }

  @EnrollmentOnly()
  @Post('exchange')
  postExchange(): { ok: boolean } {
    return { ok: true };
  }
}

/**
 * Integration test for ApiTokenGuard with real DI against in-memory SQLite.
 */
describe('ApiTokenGuard (integration)', () => {
  let app: INestApplication;
  let db: Kysely<Database>;
  let apiTokenService: ApiTokenService;
  let initToken: string;

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

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TestController],
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        ApiTokenService,
        {
          provide: APP_GUARD,
          useClass: ApiTokenGuard,
        },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();

    apiTokenService = module.get(ApiTokenService);

    // The init token was generated during onModuleInit.
    // We need to capture it — the service logs it but we can create a new one
    // for testing since we know the init token was already inserted.
    // Actually, we can't retrieve the plaintext from the service. Let's create
    // a fresh token for testing.
    const created = await apiTokenService.create('test-token');
    initToken = created.token;
  });

  afterEach(async () => {
    await app.close();
    await db.destroy();
  });

  // ── Auth: valid token ───────────────────────────────────────────────

  it('returns 200 with valid Bearer token', async () => {
    await request(app.getHttpServer())
      .get('/test/protected')
      .set('Authorization', `Bearer ${initToken}`)
      .expect(200)
      .expect((res: Response) => {
        expect((res.body as { ok: boolean }).ok).toBe(true);
      });
  });

  // ── Auth: missing header ────────────────────────────────────────────

  it('returns 401 without Authorization header', async () => {
    await request(app.getHttpServer()).get('/test/protected').expect(401);
  });

  // ── Auth: wrong token ───────────────────────────────────────────────

  it('returns 401 with wrong Bearer token', async () => {
    await request(app.getHttpServer())
      .get('/test/protected')
      .set('Authorization', 'Bearer wrong-token-value')
      .expect(401);
  });

  // ── Auth: malformed header ──────────────────────────────────────────

  it('returns 401 with non-Bearer Authorization header', async () => {
    await request(app.getHttpServer())
      .get('/test/protected')
      .set('Authorization', 'Basic some-creds')
      .expect(401);
  });

  // ── Auth: revoked token ─────────────────────────────────────────────

  it('returns 401 with revoked token', async () => {
    // Revoke the token
    const tokens = await db
      .selectFrom('api_token')
      .select('id')
      .where('label', '=', 'test-token')
      .execute();

    expect(tokens.length).toBe(1);
    await apiTokenService.revoke(tokens[0].id);

    await request(app.getHttpServer())
      .get('/test/protected')
      .set('Authorization', `Bearer ${initToken}`)
      .expect(401);
  });

  // ── Kind scoping ────────────────────────────────────────────────────

  describe('kind scoping', () => {
    it('rejects an enrollment token on a default route', async () => {
      const { token } = await apiTokenService.createEnrollment();
      await request(app.getHttpServer())
        .get('/test/protected')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });

    it('accepts an enrollment token on an @EnrollmentOnly route', async () => {
      const { token } = await apiTokenService.createEnrollment();
      await request(app.getHttpServer())
        .post('/test/exchange')
        .set('Authorization', `Bearer ${token}`)
        .expect(201);
    });

    it('rejects a static token on an @EnrollmentOnly route', async () => {
      await request(app.getHttpServer())
        .post('/test/exchange')
        .set('Authorization', `Bearer ${initToken}`)
        .expect(401);
    });

    it('accepts a session token on a default (undecorated) route', async () => {
      const { token } = await apiTokenService.create(
        'session-test-token',
        'session',
      );
      await request(app.getHttpServer())
        .get('/test/protected')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    });

    it('returns 401 with no Authorization header on an @EnrollmentOnly route', async () => {
      await request(app.getHttpServer()).post('/test/exchange').expect(401);
    });
  });

  // ── Public route ────────────────────────────────────────────────────

  it('returns 200 on @Public() route without auth', async () => {
    await request(app.getHttpServer())
      .get('/test/public')
      .expect(200)
      .expect((res: Response) => {
        expect((res.body as { ok: boolean }).ok).toBe(true);
      });
  });
});
