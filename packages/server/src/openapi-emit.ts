/**
 * Offline OpenAPI emitter. Boots the Nest application context WITHOUT opening a
 * port, builds the same document the HTTP server serves at /api-json, and writes
 * it to packages/cli/openapi.json. Run from the repo root.
 *
 *   npm run openapi:emit
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { buildOpenApiDocument } from './swagger';

const OUT = resolve(process.cwd(), 'packages/cli/openapi.json');

async function main(): Promise<void> {
  // Use the full HTTP app (builds the HTTP adapter so Swagger's route scanning
  // works) but never call app.listen(), so no port is opened.
  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  try {
    const doc = buildOpenApiDocument(app);
    writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
    process.stderr.write(`wrote ${OUT}\n`);
  } finally {
    await app.close();
  }
}

void main();
