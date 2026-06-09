# AI Agent Config from Settings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop hardcoding agent prompts and model selection. Route every AI agent's model + instructions through a single settings-backed seam (`AgentConfigService`), leaving exactly one model literal in the codebase (a bootstrap default).

**Architecture:** A new focused `AgentConfigModule` (in `src/ai/`) exports `AgentConfigService.resolve(agentKey) → { model, instructions }`. Model precedence: `setting['ai_model.<key>']` → `setting['ai_model']` → `DEFAULT_MODEL`. Instructions precedence: `setting['prompt.<key>']` → `AGENT_PROMPTS[key]` (the code default). Default prompts move out of `mastra.service.ts` and `intent-classifier.service.ts` into the `AGENT_PROMPTS` registry. Consumers (`MastraService`, `IntentClassifierService`, `ProposeDraftService`) resolve through the service. No new table — all keys live in the existing generic `setting` table.

**Tech Stack:** NestJS 11, Kysely 0.29 over better-sqlite3, Jest 30, Zod, Mastra (`@mastra/*`, stubbed in tests via `test/mastra-stub.ts`). **Node 24** (`.nvmrc`=24; the gate fails under Node 22 — better-sqlite3 NODE_MODULE_VERSION mismatch).

**Branch:** `ai-config-from-settings` (off `wave-8-interaction`, since it touches both the wave-7 AI agents and the 8a `IntentClassifierService`).

---

## Guardrails (apply to every task)

- **G1 — gate under Node 24.** Prefix every shell: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null;` then run. The final commit of every task must be preceded by `npm run build && npm run lint && npm test` green (and `npm run test:e2e` for the final task). Never commit on red.
- **G2 — real-DI integration tests** for anything reading the DB: in-memory `Kysely<Database>` + `Migrator.migrateToLatest()` + `Test.createTestingModule`. Harness to copy: `src/currency/currency.resolution.spec.ts`.
- **G3 — discriminating assertions.** Assert specific resolved values (e.g. a per-agent override model `'anthropic/claude-x'` that differs from the global and the default), not just truthiness.
- **G5 — no `any`, no `as`.** Strict TS; `npm run lint` enforces it.
- **The one-literal rule (the whole point).** After this plan, the ONLY hardcoded model string in `src/` is `DEFAULT_MODEL` in `src/ai/agent-config.ts`. No agent `instructions` string is defined at an `Agent` call site. Task 5 greps to prove it.

## Assumed current state (verified on branch)

- `MastraService` (`src/ai/mastra.service.ts`) — `initialize()` reads `setting['ai_model']` (fallback `'openai/gpt-4o-mini'`) at ~line 103-108 and builds a `triageAgent = new Agent({ id:'triage-agent', name:'Triage Agent', instructions: '<~25-line inline string>', model, tools })` at ~line 111-140. In `AiModule` (`src/ai/ai.module.ts`).
- `IntentClassifierService` (`src/interaction/router/intent-classifier.service.ts`) — module-level `const INSTRUCTIONS` + `CLARIFY_FALLBACK`; `initialize()` builds `new Agent({ id:'intent-classifier', name:'Intent Classifier', instructions: INSTRUCTIONS, model:'openai/gpt-4o-mini', tools:{} })`; `agentForTest()`; `classify()`. Standalone (no constructor deps). Provided by `InteractionModule` (`src/interaction/interaction.module.ts`), which currently imports DatabaseModule, ConversationsModule, DocumentsModule, AuditLogModule.
- `ProposeDraftService` (`src/ai/propose-draft.service.ts`) — inserts an `ai_proposal` row with a literal `model_id: 'openai/gpt-4o-mini'` at ~line 271. In `AiModule`.
- `setting` table: generic `{ key UNIQUE, value, updated_at }`. Reads via `db.selectFrom('setting').select('value').where('key','=',KEY).executeTakeFirst()`.
- Kysely injected via `@Inject(KYSELY_MODULE_CONNECTION_TOKEN())` from `nestjs-kysely`.

---

## File Structure

```
src/ai/
  agent-config.ts                # NEW: AgentKey, DEFAULT_MODEL, AGENT_PROMPTS registry, ResolvedAgentConfig
  agent-config.service.ts        # NEW: AgentConfigService.resolve/resolveModel/resolveInstructions
  agent-config.module.ts         # NEW: AgentConfigModule (exports AgentConfigService)
  agent-config.service.spec.ts   # NEW: real-DI precedence tests
  mastra.service.ts              # MODIFY: resolve('triage') for model + instructions
  ai.module.ts                   # MODIFY: import AgentConfigModule
  propose-draft.service.ts       # MODIFY: model_id = resolveModel('triage')
src/interaction/
  router/intent-classifier.service.ts   # MODIFY: inject AgentConfigService, resolve('intent_classifier')
  interaction.module.ts                 # MODIFY: import AgentConfigModule
docs/CONFIG.md                   # MODIFY: document ai_model[.<agent>] + prompt.<agent> keys
```

---

## Task 1: `AgentConfigService` + registry + module

**Files:**
- Create: `src/ai/agent-config.ts`, `src/ai/agent-config.service.ts`, `src/ai/agent-config.module.ts`
- Test: `src/ai/agent-config.service.spec.ts`

- [ ] **Step 1: Create the registry + defaults (`agent-config.ts`)**

> Move the two existing prompt strings here **verbatim** (cut-paste, do not retype):
> - `AGENT_PROMPTS.triage` ← the exact `instructions` string currently at `src/ai/mastra.service.ts` (~line 114, the `'You are a document triage agent…'` concatenation). Keep it byte-identical.
> - `AGENT_PROMPTS.intent_classifier` ← the exact `INSTRUCTIONS` template string currently in `src/interaction/router/intent-classifier.service.ts` (~line 7, `'You classify a single user message…'`).

```typescript
// src/ai/agent-config.ts
export type AgentKey = 'triage' | 'intent_classifier';

/** The SOLE hardcoded model literal in the codebase — the bootstrap default used
 * only when neither a per-agent nor a global `ai_model` setting exists. */
export const DEFAULT_MODEL = 'openai/gpt-4o-mini';

export interface ResolvedAgentConfig {
  model: string;
  instructions: string;
}

/** Default instructions per agent. Overridable at runtime by a `prompt.<key>` setting row.
 * These were moved verbatim from mastra.service.ts / intent-classifier.service.ts. */
export const AGENT_PROMPTS: Record<AgentKey, string> = {
  triage: `<<< the exact triage instructions string moved from mastra.service.ts >>>`,
  intent_classifier: `<<< the exact INSTRUCTIONS string moved from intent-classifier.service.ts >>>`,
};
```

- [ ] **Step 2: Write the failing test**

```typescript
// src/ai/agent-config.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { AgentConfigService } from './agent-config.service';
import { AGENT_PROMPTS, DEFAULT_MODEL } from './agent-config';

describe('AgentConfigService (integration)', () => {
  let db: Kysely<Database>;
  let config: AgentConfigService;

  beforeEach(async () => {
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error instanceof Error ? error : new Error('migrate failed');
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        AgentConfigService,
      ],
    }).compile();
    config = module.get(AgentConfigService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  const set = (key: string, value: string) =>
    db.insertInto('setting').values({ key, value, updated_at: 0 }).execute();

  it('falls back to DEFAULT_MODEL when no model setting exists', async () => {
    await expect(config.resolveModel('triage')).resolves.toBe(DEFAULT_MODEL);
  });

  it('uses the global ai_model when set', async () => {
    await set('ai_model', 'openai/gpt-4o');
    await expect(config.resolveModel('triage')).resolves.toBe('openai/gpt-4o');
  });

  it('prefers a per-agent override over the global model', async () => {
    await set('ai_model', 'openai/gpt-4o');
    await set('ai_model.intent_classifier', 'anthropic/claude-haiku');
    await expect(config.resolveModel('intent_classifier')).resolves.toBe('anthropic/claude-haiku');
    await expect(config.resolveModel('triage')).resolves.toBe('openai/gpt-4o');
  });

  it('falls back to the code default prompt when no prompt setting exists', async () => {
    await expect(config.resolveInstructions('triage')).resolves.toBe(AGENT_PROMPTS.triage);
  });

  it('prefers a prompt.<key> override over the code default', async () => {
    await set('prompt.intent_classifier', 'CUSTOM PROMPT');
    await expect(config.resolveInstructions('intent_classifier')).resolves.toBe('CUSTOM PROMPT');
  });

  it('resolve() returns both model and instructions', async () => {
    await set('ai_model.triage', 'openai/gpt-4o');
    const resolved = await config.resolve('triage');
    expect(resolved).toEqual({ model: 'openai/gpt-4o', instructions: AGENT_PROMPTS.triage });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `nvm use 24 && npx jest src/ai/agent-config.service.spec.ts`
Expected: FAIL — `Cannot find module './agent-config.service'`.

- [ ] **Step 4: Implement the service + module**

```typescript
// src/ai/agent-config.service.ts
import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { Database } from '../database/types';
import { AgentKey, AGENT_PROMPTS, DEFAULT_MODEL, ResolvedAgentConfig } from './agent-config';

@Injectable()
export class AgentConfigService {
  constructor(
    @Inject(KYSELY_MODULE_CONNECTION_TOKEN())
    private readonly db: Kysely<Database>,
  ) {}

  private async read(key: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('setting')
      .select('value')
      .where('key', '=', key)
      .executeTakeFirst();
    return row?.value ?? null;
  }

  /** `ai_model.<key>` → `ai_model` → DEFAULT_MODEL. */
  async resolveModel(key: AgentKey): Promise<string> {
    const perAgent = await this.read(`ai_model.${key}`);
    if (perAgent) return perAgent;
    const global = await this.read('ai_model');
    if (global) return global;
    return DEFAULT_MODEL;
  }

  /** `prompt.<key>` → AGENT_PROMPTS[key]. */
  async resolveInstructions(key: AgentKey): Promise<string> {
    const override = await this.read(`prompt.${key}`);
    return override ?? AGENT_PROMPTS[key];
  }

  async resolve(key: AgentKey): Promise<ResolvedAgentConfig> {
    const [model, instructions] = await Promise.all([
      this.resolveModel(key),
      this.resolveInstructions(key),
    ]);
    return { model, instructions };
  }
}
```

```typescript
// src/ai/agent-config.module.ts
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AgentConfigService } from './agent-config.service';

@Module({
  imports: [DatabaseModule],
  providers: [AgentConfigService],
  exports: [AgentConfigService],
})
export class AgentConfigModule {}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `nvm use 24 && npx jest src/ai/agent-config.service.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Build + lint + commit**

Run: `nvm use 24 && npm run build && npm run lint && npx jest src/ai/agent-config.service.spec.ts`
```bash
git add src/ai/agent-config.ts src/ai/agent-config.service.ts src/ai/agent-config.module.ts src/ai/agent-config.service.spec.ts
git commit -m "feat(ai): AgentConfigService — settings-backed model + prompt resolution (one-literal default)"
```

---

## Task 2: Route `MastraService` (triage agent) through `AgentConfigService`

**Files:**
- Modify: `src/ai/mastra.service.ts`, `src/ai/ai.module.ts`
- Test: `src/ai/mastra.service.spec.ts`

- [ ] **Step 1: Update the spec to require resolution via AgentConfigService**

In `src/ai/mastra.service.spec.ts`, add `AgentConfigService` to the test module providers (real-DI; the in-memory DB already runs migrations). Add a test that asserts the triage agent is built with a resolved model + instructions: seed `setting['ai_model.triage']='openai/gpt-4o'` and `setting['prompt.triage']='SEEDED TRIAGE PROMPT'`, call `initialize()`, then assert via the agent the model/instructions reflect the settings (use the existing test seam if MastraService exposes one; if not, assert that `AGENT_PROMPTS.triage` is NOT hardcoded by checking the seeded override took effect — e.g. expose the resolved value through the agent object the same way the suite already inspects the triage agent). Keep existing MastraService tests green by providing `AgentConfigService` in their module too.

> The exact assertion mechanism must match how `mastra.service.spec.ts` already inspects the created agent (it constructs the agent via the `test/mastra-stub.ts` `Agent`, whose fields are readable). Seed-then-assert the model + instructions came from settings — a discriminating value (`'openai/gpt-4o'`, `'SEEDED TRIAGE PROMPT'`) that no hardcoded path would produce.

- [ ] **Step 2: Run to confirm the new assertion fails** (model/instructions still hardcoded)

Run: `nvm use 24 && npx jest src/ai/mastra.service.spec.ts`
Expected: the new test FAILS (resolved override not honored yet).

- [ ] **Step 3: Refactor `MastraService`**

- Inject `AgentConfigService` in the constructor (alongside the existing `@Inject(KYSELY_MODULE_CONNECTION_TOKEN())` — keep Kysely if still used elsewhere; if the only DB use was the `ai_model` read, that read is now removed).
- Delete the inline `setting['ai_model']` read (~lines 102-108) and the `const model = …` fallback.
- Replace the inline `instructions: '<~25-line string>'` and `model,` in the `new Agent({...})` with:
  ```typescript
  const triage = await this.config.resolve('triage');
  const triageAgent = new Agent({
    id: 'triage-agent',
    name: 'Triage Agent',
    instructions: triage.instructions,
    model: triage.model,
    tools,
  });
  ```
- The ~25-line triage instruction string must now live ONLY in `AGENT_PROMPTS.triage` (Task 1 moved it). Confirm it is gone from `mastra.service.ts`.

In `src/ai/ai.module.ts`: add `AgentConfigModule` to the `imports` array (and the import statement).

- [ ] **Step 4: Run tests to verify pass**

Run: `nvm use 24 && npm run build && npm run lint && npx jest src/ai`
Expected: PASS (mastra + all ai specs green; zero `any`/`as`).

- [ ] **Step 5: Commit**

```bash
git add src/ai/mastra.service.ts src/ai/ai.module.ts src/ai/mastra.service.spec.ts
git commit -m "refactor(ai): MastraService triage agent resolves model+prompt via AgentConfigService"
```

---

## Task 3: Route `IntentClassifierService` through `AgentConfigService`

**Files:**
- Modify: `src/interaction/router/intent-classifier.service.ts`, `src/interaction/interaction.module.ts`
- Test: `src/interaction/router/intent-classifier.service.spec.ts`

- [ ] **Step 1: Update the spec to inject AgentConfigService**

The classifier test currently builds the service with no providers and calls `await service.initialize()`. After the refactor, `initialize()` needs `AgentConfigService`. Provide a lightweight fake so the unit test stays focused on `classify()` (it does not test config resolution — Task 1 covers that):

```typescript
// in intent-classifier.service.spec.ts
import { AgentConfigService } from '../../ai/agent-config.service';
import { AGENT_PROMPTS, DEFAULT_MODEL } from '../../ai/agent-config';

class FakeAgentConfig {
  resolve(): Promise<{ model: string; instructions: string }> {
    return Promise.resolve({ model: DEFAULT_MODEL, instructions: AGENT_PROMPTS.intent_classifier });
  }
}

// in beforeEach providers:
//   { provide: AgentConfigService, useClass: FakeAgentConfig },
//   IntentClassifierService,
```
Keep both existing tests (happy classify + degrade-to-clarify); they still call `await service.initialize()` then spy on `agentForTest().generate`. No assertion change needed beyond wiring the provider.

- [ ] **Step 2: Run to confirm it fails** (constructor/DI mismatch until the service is refactored)

Run: `nvm use 24 && npx jest src/interaction/router/intent-classifier.service.spec.ts`
Expected: FAIL (the fake provider isn't consumed yet / constructor has no `AgentConfigService`).

- [ ] **Step 3: Refactor `IntentClassifierService`**

```typescript
// src/interaction/router/intent-classifier.service.ts
import { Injectable } from '@nestjs/common';
import { Agent } from '@mastra/core/agent';
import { AgentConfigService } from '../../ai/agent-config.service';
import { routedIntentSchema, mapToRoutedIntent } from './routed-intent.schema';
import { RoutedIntent } from './types';

const CLARIFY_FALLBACK = 'Could you rephrase what you need?';

@Injectable()
export class IntentClassifierService {
  private agent: Agent | null = null;

  constructor(private readonly config: AgentConfigService) {}

  async initialize(): Promise<void> {
    const { model, instructions } = await this.config.resolve('intent_classifier');
    this.agent = new Agent({
      id: 'intent-classifier',
      name: 'Intent Classifier',
      instructions,
      model,
      tools: {},
    });
  }

  agentForTest(): Agent {
    if (!this.agent) throw new Error('IntentClassifierService not initialized');
    return this.agent;
  }

  async classify(message: string): Promise<RoutedIntent> {
    if (!this.agent) throw new Error('IntentClassifierService not initialized');
    const result = await this.agent.generate(message, {
      structuredOutput: { schema: routedIntentSchema },
    });
    const parsed = routedIntentSchema.safeParse(result.object);
    if (!parsed.success) {
      return { kind: 'clarify', question: CLARIFY_FALLBACK };
    }
    return mapToRoutedIntent(parsed.data);
  }
}
```
The `INSTRUCTIONS` const is deleted (it now lives in `AGENT_PROMPTS.intent_classifier`).

In `src/interaction/interaction.module.ts`: add `AgentConfigModule` to `imports` (+ the import statement) so `AgentConfigService` resolves for `IntentClassifierService`.

- [ ] **Step 4: Run tests to verify pass**

Run: `nvm use 24 && npm run build && npm run lint && npx jest src/interaction`
Expected: PASS (classifier + all interaction specs green).

- [ ] **Step 5: Commit**

```bash
git add src/interaction/router/intent-classifier.service.ts src/interaction/interaction.module.ts src/interaction/router/intent-classifier.service.spec.ts
git commit -m "refactor(interaction): IntentClassifier resolves model+prompt via AgentConfigService"
```

---

## Task 4: `ProposeDraftService` records the resolved model

**Files:**
- Modify: `src/ai/propose-draft.service.ts`
- Test: `src/ai/propose-draft.service.spec.ts`

- [ ] **Step 1: Update the spec**

The proposal-recording test asserts the persisted `ai_proposal.model_id`. Seed `setting['ai_model.triage']='openai/gpt-4o'` (or global `ai_model`) and assert the inserted `model_id` equals the resolved value (`'openai/gpt-4o'`), not the old literal. Provide `AgentConfigService` in the test module (real-DI). If no existing test inspects `model_id`, add one.

- [ ] **Step 2: Run to confirm fail** (literal `'openai/gpt-4o-mini'` ≠ seeded `'openai/gpt-4o'`)

Run: `nvm use 24 && npx jest src/ai/propose-draft.service.spec.ts`
Expected: the model_id assertion FAILS.

- [ ] **Step 3: Refactor**

Inject `AgentConfigService`; replace the literal at ~line 271:
```typescript
        model_id: await this.config.resolveModel('triage'),
```
(`ProposeDraftService` is in `AiModule`, which now imports `AgentConfigModule` from Task 2 — `AgentConfigService` is injectable.)

- [ ] **Step 4: Run tests to verify pass**

Run: `nvm use 24 && npm run build && npm run lint && npx jest src/ai`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ai/propose-draft.service.ts src/ai/propose-draft.service.spec.ts
git commit -m "refactor(ai): record the resolved model on ai_proposal, not a literal"
```

---

## Task 5: Document the settings + the one-literal gate

**Files:**
- Modify: `docs/CONFIG.md`
- (no code)

- [ ] **Step 1: Document the keys in `docs/CONFIG.md`**

Add to the config reference (the AI/agent section, or create a short one): `ai_model` (global default model), `ai_model.<agent>` (per-agent override, agents: `triage`, `intent_classifier`), `prompt.<agent>` (override the code-default instructions). Note the resolution precedence and that absent both, the bootstrap `DEFAULT_MODEL` in `src/ai/agent-config.ts` applies.

- [ ] **Step 2: Prove the one-literal rule (grep gate — must show ONLY agent-config.ts)**

Run:
```bash
grep -rn "openai/\|gpt-4o\|claude-\|anthropic/" src --include=*.ts | grep -v ".spec.ts"
```
Expected: the ONLY production hit is `DEFAULT_MODEL = 'openai/gpt-4o-mini'` in `src/ai/agent-config.ts`. No model literal in `mastra.service.ts`, `intent-classifier.service.ts`, or `propose-draft.service.ts`. Also confirm no agent `instructions:` is assigned a literal string:
```bash
grep -rn "instructions:" src --include=*.ts | grep -v ".spec.ts"
```
Expected: only `instructions: triage.instructions` / `instructions,` (resolved values) — no inline prose.

- [ ] **Step 3: Full wave gate**

Run: `nvm use 24 && npm run build && npm run lint && npm run test && npm run test:e2e`
Expected: all green (build 0, lint 0, all unit suites, all e2e suites).

- [ ] **Step 4: Commit**

```bash
git add docs/CONFIG.md
git commit -m "docs(config): document ai_model[.<agent>] + prompt.<agent> resolution"
```

---

## Self-Review (author checklist — completed)

**1. Spec coverage:**
- Settings-backed model resolution (global + per-agent override) → Task 1 (`resolveModel`), consumed in Tasks 2/3/4. ✅
- Settings-backed prompt resolution (code default + DB override) → Task 1 (`resolveInstructions` + `AGENT_PROMPTS`), prompts moved out of consumers in Tasks 2/3. ✅
- Single seam `AgentConfigService` in its own `AgentConfigModule` (so `InteractionModule` need not import all of `AiModule`) → Task 1; imported by `AiModule` (Task 2) and `InteractionModule` (Task 3). ✅
- `propose-draft` model literal → resolved → Task 4. ✅
- One-literal rule proven + keys documented → Task 5. ✅

**2. Placeholder scan:** the only intentional placeholders are the `<<< … moved verbatim >>>` markers in Task 1's `AGENT_PROMPTS` — these are explicit cut-paste instructions citing the exact source line, not vague TODOs (retyping a 25-line prompt would risk divergence). Everything else is complete code.

**3. Type consistency:** `AgentKey` (`'triage' | 'intent_classifier'`), `ResolvedAgentConfig` (`{model, instructions}`), `resolve`/`resolveModel`/`resolveInstructions`, `AGENT_PROMPTS`, `DEFAULT_MODEL` are used consistently across Tasks 1-5.

---

## Execution Handoff

5 tasks, each red→green→commit under Node 24. Tasks are sequential (Task 1 defines the service; 2/3/4 consume it; 5 documents + gates). Recommended: subagent-driven, fresh subagent per task + two-stage review.
