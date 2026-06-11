import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
// Internal paths (no public API for this) — revisit if @nestjs/serve-static bumps a major.
import { AbstractLoader } from '@nestjs/serve-static/dist/loaders/abstract.loader';
import { ExpressLoader } from '@nestjs/serve-static/dist/loaders/express.loader';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

/**
 * Operator SPA serve-static wiring (ADR-0030): the page is served at "/" by
 * static middleware that runs ahead of the global ApiTokenGuard, while the API
 * stays guarded. We don't run a real Vite build here — we drop a placeholder
 * packages/web/dist/index.html so ServeStaticModule has a file to serve.
 *
 * The distDir is resolved via the same node module resolution that app.module.ts
 * uses in production — cwd-independent and correct in both local and Docker.
 */
describe('Operator SPA serving (e2e)', () => {
  let app: INestApplication<App>;
  const distDir = path.join(
    path.dirname(
      createRequire(__filename).resolve('@headless-bookkeeping/web/package.json'),
    ),
    'dist',
  );
  const indexFile = path.join(distDir, 'index.html');
  let createdIndex = false;
  let createdDir = false;

  beforeAll(async () => {
    if (!fs.existsSync(indexFile)) {
      // Remember whether we had to create the dir so we can remove it cleanly
      // (a real Vite build owns frontend/dist; the test must not litter it).
      createdDir = !fs.existsSync(distDir);
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
    await app?.close();
    if (createdIndex) fs.rmSync(indexFile, { force: true });
    if (createdDir) fs.rmSync(distDir, { recursive: true, force: true });
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

  it('does not let static serving shadow the /admin path prefix', async () => {
    const res = await request(app.getHttpServer()).get('/admin/settings');
    expect(res.status).toBe(401); // reaches the guard, not the static index
  });

  it('does not let static serving shadow /health (stays a real route, not the SPA)', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    // The real HealthController returns JSON, not the SPA index HTML.
    expect(res.text).not.toContain('id="root"');
  });
});
