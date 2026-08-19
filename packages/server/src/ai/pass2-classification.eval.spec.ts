import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { EntitiesService } from '../entities/entities.service';
import { ExpensesService } from '../expenses/expenses.service';
import { VoucherProjectionService } from '../ledger/projection/voucher-projection.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { CurrencyService } from '../currency/currency.service';
import { OrganizationService } from '../organization/organization.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { CategoryService } from '../categories/category.service';
import { AgentConfigService } from './agent-config.service';
import { MastraService } from './mastra.service';
import { Pass2AgentService } from './pass2-agent.service';
import { EE_CLASSIFICATION_EVALS } from './__fixtures__/ee-classification-evals';
import { AuditLogService } from '../audit-log/audit-log.service';

/**
 * Pass-2 EE classification evals — an env-gated, real-model regression lock
 * for the order-vs-invoice incident (2026-07-15, see
 * `__fixtures__/ee-classification-evals.ts` for the full writeup).
 *
 * WHY ENV-GATED: unlike the deterministic guards in Tasks 1-6, this suite
 * asks a REAL model to classify real prod OCR text. That is non-deterministic
 * and costs tokens/latency, so it must never run in the default `jest` / CI
 * invocation. The gate below skips the entire `describe` block unless the
 * operator opts in explicitly.
 *
 * HOW TO RUN FOR REAL (manual/periodic, not CI):
 *
 *   cd packages/server
 *   RUN_LLM_EVALS=1 \
 *   AI_MODEL='openai/gpt-4o-mini' \
 *   AI_BASE_URL='https://your-inference-endpoint/v1' \
 *   AI_API_KEY='sk-...' \
 *   npx jest src/ai/pass2-classification.eval.spec.ts
 *
 * `RUN_LLM_EVALS=1` un-skips the suite; `AI_MODEL`/`AI_BASE_URL`/`AI_API_KEY`
 * are read below and seeded into the `setting` table so
 * `AgentConfigService.resolveModelConfig` (which the real `MastraService`
 * agents call) resolves to a reachable inference endpoint instead of the
 * bootstrap default. Without a reachable endpoint the suite will still run
 * (it is no longer skipped) but every case will fail/time out — that failure
 * mode is expected and orthogonal to the skip behavior this file guarantees.
 *
 * IMPORTANT CAVEAT FOR WHOEVER RUNS THIS: `jest.config.cjs` maps
 * `@mastra/core`(`/agent`) to `test/mastra-stub.ts` for EVERY spec file
 * (there is no exemption for `RUN_LLM_EVALS`). That is NOT because the real
 * `@mastra/*` packages are ESM-only — they ship working CJS builds, and a
 * plain `require('@mastra/core/agent')` loads fine under plain Node. The
 * actual blocker is Jest's runtime: removing the moduleNameMapper entry makes
 * Jest try to load `@mastra/core`'s own transitive ESM dependencies (`p-map`,
 * `tokenx`, ...), which Jest's CJS transform cannot handle — that was tried
 * and is not cheaply fixable. So a plain `npx jest` invocation — even with
 * `RUN_LLM_EVALS=1` — always exercises the stub `Agent.generate()` (which
 * always returns `{ object: undefined, text: '' }`), NOT a live model.
 *
 * To actually reach a real model, use the standalone runner instead:
 *
 *   AI_MODEL=... AI_BASE_URL=... AI_API_KEY=... \
 *   npx ts-node --transpile-only packages/server/scripts/run-classification-evals.ts
 *
 * (`ts-node`, not `tsx` — `tsx`'s esbuild transpile does not emit the
 * `design:paramtypes` decorator metadata NestJS's constructor injection
 * depends on, so under `tsx` every constructor-injected provider silently
 * resolves to `undefined` instead of throwing a clear DI error; see the
 * runner script's header for the empirical detail.)
 *
 * It builds the identical real Nest DI graph as this spec (see
 * `beforeEach` below) but runs entirely outside Jest, so it reaches a real
 * `@mastra/core` `Agent` and a real inference endpoint. This spec still locks
 * in the correct wiring (real Nest DI graph, EE plugin, env-seeded model
 * config) for whenever it runs under Jest with `RUN_LLM_EVALS=1`.
 */
const run = process.env.RUN_LLM_EVALS === '1' ? describe : describe.skip;

run('Pass-2 classification evals (EE)', () => {
  jest.setTimeout(60_000);

  let db: Kysely<Database>;
  let module: TestingModule;
  let pass2: Pass2AgentService;

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

    module = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        OrganizationService,
        NullCountryPlugin,
        EstoniaCountryPlugin,
        PluginLoader,
        OrgContextResolver,
        CurrencyService,
        VoucherProjectionService,
        EntitiesService,
        AuditLogService,
        ExpensesService,
        PeriodLockService,
        CategoryService,
        AgentConfigService,
        MastraService,
        Pass2AgentService,
      ],
    }).compile();

    // Seed the org as Estonian so EstoniaCountryPlugin is the active plugin —
    // its getDocumentClassificationHints() (Task 3/4) must reach the prompt.
    const organizationService = module.get(OrganizationService);
    await organizationService.updateOrganization({ country: 'EE' });

    // Seed model/inference settings from the operator's environment.
    // RUN_LLM_EVALS=1 implies the operator ALSO set AI_MODEL/AI_BASE_URL/
    // AI_API_KEY — these are read here (not hardcoded) so
    // AgentConfigService.resolveModelConfig resolves to a real, reachable
    // endpoint rather than the bootstrap DEFAULT_MODEL, which is why this
    // suite is env-gated in the first place.
    const now = Math.floor(Date.now() / 1000);
    const envSettings: Array<[string, string | undefined]> = [
      ['ai_model', process.env.AI_MODEL],
      ['ai_base_url', process.env.AI_BASE_URL],
      ['ai_api_key', process.env.AI_API_KEY],
    ];
    for (const [key, value] of envSettings) {
      if (!value) continue;
      await db
        .insertInto('setting')
        .values({ key, value, updated_at: now })
        .execute();
    }

    pass2 = module.get(Pass2AgentService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  for (const c of EE_CLASSIFICATION_EVALS) {
    it(c.name, async () => {
      const out = await pass2.classify(c.markdown, {
        orgContext: {
          name: 'override OÜ',
          vatNumber: 'EE102983355',
          iban: null,
        },
        directionHint: 'incoming',
      });

      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.result.document_type).toBe(c.expect.document_type);
        if (c.expect.kind) expect(out.result.kind).toBe(c.expect.kind);
      }
    });
  }
});
