import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { Kysely, SqliteDialect } from 'kysely';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../src/database/types';
import { seedApiToken } from './e2e-auth';

describe('Mobile enrollment auth (e2e)', () => {
  let app: INestApplication;
  let db: Kysely<Database>;
  let staticToken: string;

  beforeAll(async () => {
    process.env.PUBLIC_API_URL = 'https://api.example.test';
    const rawDb = new SqliteDb(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: rawDb }),
    });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(KYSELY_MODULE_CONNECTION_TOKEN())
      .useValue(db)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    staticToken = await seedApiToken(db);
  });

  afterAll(async () => app.close());

  it('runs the full enroll → exchange → call → revoke cycle', async () => {
    // 1. Operator mints an enrollment token.
    const enrollRes = await request(app.getHttpServer())
      .post('/api/device-enrollments')
      .set('Authorization', `Bearer ${staticToken}`)
      .expect(201);
    expect(enrollRes.body.apiBaseUrl).toBe('https://api.example.test');
    expect(typeof enrollRes.body.enrollmentToken).toBe('string');
    expect(typeof enrollRes.body.expiresAt).toBe('string');
    const enroll = enrollRes.body.enrollmentToken as string;

    // 2. Exchange it for a session token.
    const exchangeRes = await request(app.getHttpServer())
      .post('/api/mobile/sessions')
      .set('Authorization', `Bearer ${enroll}`)
      .send({ deviceName: 'iPhone QA' })
      .expect(201);
    const session = exchangeRes.body.accessToken as string;
    expect(typeof session).toBe('string');

    // 3. Session token works on a normal API route.
    await request(app.getHttpServer())
      .get('/api/organization')
      .set('Authorization', `Bearer ${session}`)
      .expect(200);

    // 4. The same enrollment token cannot be exchanged again.
    await request(app.getHttpServer())
      .post('/api/mobile/sessions')
      .set('Authorization', `Bearer ${enroll}`)
      .send({ deviceName: 'dupe' })
      .expect(401);

    // 5. Self-revoke, then the session token stops working.
    await request(app.getHttpServer())
      .post('/api/mobile/sessions/revoke')
      .set('Authorization', `Bearer ${session}`)
      .expect(204);
    await request(app.getHttpServer())
      .get('/api/organization')
      .set('Authorization', `Bearer ${session}`)
      .expect(401);
  });

  it('rejects an enrollment token on a normal API route', async () => {
    const enrollRes = await request(app.getHttpServer())
      .post('/api/device-enrollments')
      .set('Authorization', `Bearer ${staticToken}`)
      .expect(201);
    await request(app.getHttpServer())
      .get('/api/organization')
      .set('Authorization', `Bearer ${enrollRes.body.enrollmentToken}`)
      .expect(401);
  });
});
