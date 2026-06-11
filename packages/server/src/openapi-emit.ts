import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { buildOpenApiDocument } from './swagger';
import { repoRoot } from './common/paths';

const OUT = join(repoRoot(), 'packages/cli/openapi.json');

async function main(): Promise<void> {
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
