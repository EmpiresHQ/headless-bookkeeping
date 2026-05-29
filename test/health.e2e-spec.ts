import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, Module } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppController } from './../src/app.controller';
import { AppService } from './../src/app.service';

// Mock DatabaseModule to avoid migration issues in e2e tests
@Module({
  providers: [
    {
      provide: 'KYSELY_DB',
      useValue: {},
    },
  ],
  exports: ['KYSELY_DB'],
})
class MockDatabaseModule {}

describe('HealthEndpoint (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [MockDatabaseModule],
      controllers: [AppController],
      providers: [
        {
          provide: AppService,
          useValue: {
            getHello: jest.fn().mockResolvedValue('Hello World!'),
            getUsers: jest.fn().mockResolvedValue([]),
            onModuleInit: jest.fn(),
          },
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/health (GET) - returns status ok and timestamp', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect((res) => {
        expect(res.body.status).toBe('ok');
        expect(res.body.timestamp).toBeDefined();
        expect(new Date(res.body.timestamp).toISOString()).toBe(res.body.timestamp);
      });
  });

  afterEach(async () => {
    await app.close();
  });
});
