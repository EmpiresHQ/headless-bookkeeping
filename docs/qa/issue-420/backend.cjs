// SYNTHETIC QA ONLY. Real Nest services/SQLite/HTTP; inference boundary is deterministic.
const path = require('node:path');
const root = process.cwd();
if (!root.endsWith('/issue-420'))
  throw Error('Run only in isolated issue-420 worktree');
process.env.DATA_DIR = path.join(root, 'data/qa-420');
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
    createHash('sha256').update('synthetic-420-local-only').digest('hex'),
    'Synthetic QA #420',
  );
  if (!db.prepare('SELECT id FROM entity WHERE id=1').get()) {
    db.prepare(
      'INSERT INTO entity(id,role,country,name,created_at,updated_at) VALUES (1,?,?,?,?,?)',
    ).run('supplier', 'IE', 'SYNTHETIC QA420 supplier', now, now);
    db.prepare(
      "UPDATE policy_config SET value='false' WHERE key='unknown_supplier_requires_approval'",
    ).run();
    db.prepare(
      "UPDATE policy_config SET value='0' WHERE key='auto_post_min_confidence'",
    ).run();
    const account = db
      .prepare("SELECT id FROM account WHERE code='BANK_EUR'")
      .get().id;
    db.prepare(
      'INSERT INTO bank_statement(id,account_id,start_date,end_date,uploaded_at) VALUES (1,?,?,?,?)',
    ).run(account, '2026-09-01', '2026-09-30', now);
    for (let id = 1; id <= 8; id++)
      db.prepare(
        'INSERT INTO bank_transaction(id,statement_id,account_id,transaction_date,description,reference,amount,currency,status,created_at) VALUES (?,1,?,?,?,?,?,?,?,?)',
      ).run(
        id,
        account,
        '2026-09-10',
        `SYNTHETIC network QA line ${id}`,
        `QA420-${id}`,
        -(12000 + id * 100),
        'EUR',
        'open',
        now,
      );
  }
  db.prepare(
    "INSERT INTO policy_config(key,value,updated_at) VALUES ('auto_post_enabled','true',?) ON CONFLICT(key) DO UPDATE SET value='true'",
  ).run(now);
  db.close();
  await app.listen(4420, '127.0.0.1');
  console.log(
    'QA420 backend ready :4420; accounting services real; inference fixture; workers/cron disabled',
  );
  process.on('SIGTERM', async () => {
    await app.close();
    process.exit(0);
  });
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
