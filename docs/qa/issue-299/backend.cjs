// SYNTHETIC QA ONLY. Real Nest services/SQLite/HTTP; inference boundary is deterministic.
const path = require('node:path');
const root = process.cwd();
if (!root.endsWith('/issue-299'))
  throw Error('Run only in isolated issue-299 worktree');
process.env.DATA_DIR = path.join(root, 'data/qa-299');
process.env.NODE_ENV = 'test'; // disables automatic intake polling and logger threads
process.env.TS_NODE_PROJECT = path.join(root, 'packages/server/tsconfig.json');
require('ts-node/register/transpile-only');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const src = (name) => require(path.join(root, 'packages/server/src', name));
const { AppModule } = src('app.module.ts');
const { DocumentTranscriber } = src('triage/document-transcriber.port.ts');
const { Pass2AgentService } = src('ai/pass2-agent.service.ts');
const { triageResultSchema } = src('triage/types.ts');
const { SchedulerRegistry } = require('@nestjs/schedule');
const { ZodValidationPipe } = src('common/pipes/zod-validation.pipe.ts');
const { createHash } = require('node:crypto');
const DB = require('better-sqlite3');
(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DocumentTranscriber)
    .useValue({
      transcribe: async (file) => ({
        ok: true,
        markdown: `SYNTHETIC QA receipt ${file.filename}`,
      }),
    })
    .overrideProvider(Pass2AgentService)
    .useValue({
      classify: async (markdown) => ({
        ok: true,
        enrichment: {
          summary: 'SYNTHETIC deterministic supplier',
          supplier: { matchEntityId: 1 },
        },
        result: triageResultSchema.parse({
          kind: 'new_expense',
          document_type: 'receipt',
          gross_amount: 23100,
          vat_amount: 0,
          tax_point_date: '2026-09-10',
          category: 'software',
          currency: 'EUR',
          confidence: 0.99,
          supplier_invoice_number: markdown,
          supplier_proposal: { mode: 'match', match_entity_id: 1 },
        }),
      }),
    })
    .compile();
  const app = mod.createNestApplication();
  app.useGlobalPipes(new ZodValidationPipe());
  await app.init();
  for (const job of app.get(SchedulerRegistry).getCronJobs().values())
    job.stop();
  const db = new DB(path.join(process.env.DATA_DIR, 'app.sqlite'));
  db.pragma('foreign_keys=ON');
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    'INSERT OR IGNORE INTO api_token(token_hash,label) VALUES (?,?)',
  ).run(
    createHash('sha256').update('synthetic-299-local-only').digest('hex'),
    'Synthetic QA #299',
  );
  if (!db.prepare('SELECT id FROM entity WHERE id=1').get()) {
    const insert = db.prepare(
      'INSERT INTO entity(id,role,country,name,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    );
    for (let id = 1; id <= 20; id++)
      insert.run(
        id,
        'supplier',
        'IE',
        `SYNTHETIC QA299 very long supplier name for a scrolling form — supplier ${id}`,
        now,
        now,
      );
  }
  db.close();
  await app.listen(4299, '127.0.0.1');
  console.log(
    'QA299 backend ready :4299; accounting services real; inference fixture; workers/cron disabled',
  );
  process.on('SIGTERM', async () => {
    await app.close();
    process.exit(0);
  });
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
