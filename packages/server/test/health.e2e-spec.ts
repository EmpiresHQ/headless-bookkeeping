import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { HealthController } from './../src/health/health.controller';

describe('HealthEndpoint (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    // HealthController has no dependencies — boot it directly, no DB mock.
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('/health (GET) - returns status ok and an ISO timestamp', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect((res: { body: { status: string; timestamp: string } }) => {
        expect(res.body.status).toBe('ok');
        expect(res.body.timestamp).toBeDefined();
        expect(new Date(res.body.timestamp).toISOString()).toBe(
          res.body.timestamp,
        );
      });
  });
});
