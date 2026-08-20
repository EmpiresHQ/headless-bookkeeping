/**
 * Standalone runner for the Pass-2 EE classification evals — the ONLY way to
 * actually exercise them against a real model.
 *
 * WHY THIS EXISTS: `packages/server/src/ai/pass2-classification.eval.spec.ts`
 * (Task 7) is a Jest spec, and `jest.config.cjs` maps `@mastra/core`(`/agent`)
 * to `test/mastra-stub.ts` for EVERY spec file, with no exemption for
 * `RUN_LLM_EVALS`. That means `npx jest ... pass2-classification.eval.spec.ts`
 * — even with `RUN_LLM_EVALS=1` — always exercises the stub `Agent.generate()`
 * (which returns `{ object: undefined, text: '' }`), never a live model.
 *
 * This is NOT because `@mastra/*` are ESM-only — they ship working CJS
 * builds, and a plain `require('@mastra/core/agent')` loads fine under plain
 * Node. The real blocker is Jest's runtime: removing the moduleNameMapper
 * entry makes Jest try to load `@mastra/core`'s own transitive dependencies
 * (`p-map`, `tokenx`, ...), which are themselves ESM and which Jest's CJS
 * transform cannot handle — that path was tried and fails, and is not cheaply
 * fixable. So the fix is to run the eval OUTSIDE Jest entirely, via this
 * script, which builds the identical real Nest DI graph the spec does and
 * calls `Pass2AgentService.classify()` directly against a real model.
 *
 * RUN — use `ts-node --transpile-only`, NOT `tsx`:
 *
 *   cd packages/server
 *   AI_MODEL='openai/gpt-4o-mini' \
 *   AI_BASE_URL='https://your-inference-endpoint/v1' \
 *   AI_API_KEY='sk-...' \
 *   npx ts-node --transpile-only scripts/run-classification-evals.ts
 *
 * (equivalently, from the repo root:
 *   AI_MODEL=... AI_BASE_URL=... AI_API_KEY=... npx ts-node --transpile-only packages/server/scripts/run-classification-evals.ts )
 *
 * WHY ts-node AND NOT tsx: `tsx` transpiles per-file through esbuild, which
 * does NOT emit TypeScript's `design:paramtypes` decorator metadata (that
 * emission needs the real TS compiler, which `ts-node` — even in
 * `--transpile-only` mode — invokes). NestJS's constructor injection reads
 * that metadata to resolve untyped-token dependencies (e.g.
 * `constructor(private readonly mastraService: MastraService)`). Under
 * `tsx`, `Reflect.getMetadata('design:paramtypes', ...)` comes back
 * `undefined` for EVERY class, so every constructor-injected provider is
 * silently `undefined` — no DI error is thrown; each provider simply
 * *exists* (as an empty shell) until a method on one of its injected
 * dependencies is called, which throws deep inside `classify()`
 * (`Cannot read properties of undefined (reading 'buildTriageEnrichmentAgent')`)
 * — a failure that is easy to mistake for "reached the model and failed" but
 * is actually a silently broken DI graph. This was verified empirically
 * while building this script; `ts-node --transpile-only` resolves the exact
 * same graph correctly and reaches a real network/model call. `ts-node` is
 * already a `packages/server` devDependency (used by the existing
 * `openapi:emit` script), so no new dependency is introduced.
 *
 * Needs a REACHABLE inference endpoint — without one every case fails/errors
 * at the network/model-config call, which is the expected (not a wiring bug)
 * failure mode. Exits non-zero if any case fails, so this can be wired into a
 * periodic (non-CI-blocking) job once a real endpoint is available.
 */
import { Test } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../src/database/types';
import { migrations } from '../src/database/migrations';
import { EntitiesService } from '../src/entities/entities.service';
import { ExpensesService } from '../src/expenses/expenses.service';
import { AuditLogService } from '../src/audit-log/audit-log.service';
import { VoucherProjectionService } from '../src/ledger/projection/voucher-projection.service';
import { PluginLoader } from '../src/plugins/plugin-loader.service';
import { NullCountryPlugin } from '../src/plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../src/plugins/estonia-country.plugin';
import { CurrencyService } from '../src/currency/currency.service';
import { OrganizationService } from '../src/organization/organization.service';
import { OrgContextResolver } from '../src/organization/org-context.resolver';
import { PeriodLockService } from '../src/reporting-periods/period-lock.service';
import { CategoryService } from '../src/categories/category.service';
import { AgentConfigService } from '../src/ai/agent-config.service';
import { MastraService } from '../src/ai/mastra.service';
import { Pass2AgentService } from '../src/ai/pass2-agent.service';
import { EE_CLASSIFICATION_EVALS } from '../src/ai/__fixtures__/ee-classification-evals';

async function main(): Promise<void> {
  const rawDb = new SqliteDb(':memory:');
  rawDb.pragma('foreign_keys = ON');
  const db = new Kysely<Database>({
    dialect: new SqliteDialect({ database: rawDb }),
  });

  try {
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error)
      throw error instanceof Error ? error : new Error('Migration failed');

    // Build the SAME real Nest DI graph as the Jest eval spec (see
    // pass2-classification.eval.spec.ts) — real Pass2AgentService,
    // MastraService, AgentConfigService, and the EE country plugin.
    const module = await Test.createTestingModule({
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

    // Seed the org as Estonian so EstoniaCountryPlugin is the active
    // plugin — its getDocumentClassificationHints() must reach the prompt.
    const organizationService = module.get(OrganizationService);
    await organizationService.updateOrganization({ country: 'EE' });

    // Seed model/inference settings from the operator's environment so
    // AgentConfigService.resolveModelConfig resolves to a reachable
    // endpoint instead of the bootstrap DEFAULT_MODEL.
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

    const pass2 = module.get(Pass2AgentService);

    let passCount = 0;
    let failCount = 0;

    for (const c of EE_CLASSIFICATION_EVALS) {
      try {
        const out = await pass2.classify(c.markdown, {
          orgContext: {
            name: 'override OÜ',
            vatNumber: 'EE102983355',
            iban: null,
          },
          directionHint: 'incoming',
        });

        const ok =
          out.ok &&
          out.result.document_type === c.expect.document_type &&
          (!c.expect.kind || out.result.kind === c.expect.kind);

        if (ok) {
          passCount++;
          process.stdout.write(`PASS  ${c.name}\n`);
        } else {
          failCount++;
          const detail = out.ok
            ? `document_type=${out.result.document_type} kind=${String(out.result.kind)}`
            : `category=${out.category} detail=${out.detail}`;
          process.stdout.write(`FAIL  ${c.name}  (${detail})\n`);
        }
      } catch (err) {
        failCount++;
        const message = err instanceof Error ? err.message : String(err);
        process.stdout.write(`FAIL  ${c.name}  (threw: ${message})\n`);
      }
    }

    process.stdout.write(
      `\n${passCount}/${EE_CLASSIFICATION_EVALS.length} passed, ${failCount} failed\n`,
    );

    await module.close();

    if (failCount > 0) process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

void main();
