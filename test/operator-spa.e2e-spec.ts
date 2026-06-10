import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AbstractLoader } from '@nestjs/serve-static/dist/loaders/abstract.loader';
import { ExpressLoader } from '@nestjs/serve-static/dist/loaders/express.loader';
import * as fs from 'node:fs';
import * as path from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

/**
 * Operator SPA serve-static wiring (ADR-0029): the page is served at "/" by
 * static middleware that runs ahead of the global ApiTokenGuard, while the API
 * stays guarded. We don't run a real Vite build here — we drop a placeholder
 * frontend/dist/index.html so ServeStaticModule has a file to serve.
 */
describe('Operator SPA serving (e2e)', () => {
  let app: INestApplication<App>;
  const distDir = path.join(process.cwd(), 'frontend', 'dist');
  const indexFile = path.join(distDir, 'index.html');
  let createdIndex = false;

  beforeAll(async () => {
    if (!fs.existsSync(indexFile)) {
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(indexFile, '<!doctype html><div id="root">spa</div>');
      createdIndex = true;
    }
    // @nestjs/serve-static resolves the loader via a useFactory that checks
    // httpAdapterHost.httpAdapter at module-compile time. In the NestJS
    // TestingModule the HTTP adapter is not yet wired when .compile() runs, so
    // the factory falls back to NoopLoader (no-op). We override AbstractLoader
    // with ExpressLoader to force the static middleware to actually register —
    // this is the same loader that production uses (ExpressAdapter is the
    // platform in both main.ts and this test).
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AbstractLoader)
      .useClass(ExpressLoader)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    if (createdIndex) fs.rmSync(indexFile, { force: true });
  });

  it('serves the SPA index at "/" without a token (not guarded)', async () => {
    const res = await request(app.getHttpServer()).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="root"');
  });

  it('still guards the API: GET /api/organization without a token is 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/organization');
    expect(res.status).toBe(401);
  });

  it('does not let static serving shadow the API path prefix', async () => {
    const res = await request(app.getHttpServer()).get('/api/expenses');
    expect(res.status).toBe(401);
  });
});
