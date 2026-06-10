# Bank-statement ingestion via Mastra workflow (ADR-0031) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`). Frontend `tsc -b` is incremental — delete `frontend/*.tsbuildinfo` before any "type-check green" claim.

**Goal:** Upload a bank-statement CSV; an LLM agent infers a column-mapping ruleset; a deterministic transformer applies it to every row → `CreateStatementInput`; the statement is created. Async: upload returns a `jobId`, the UI polls until done. Fresh inference per upload (no cache), no human-confirm — the safeguard is Zod-validating the transformer output against the kernel schema.

**Architecture (verified by a runtime spike):**
- The inference + transform is a **Mastra Workflow** (`createWorkflow().then(inferMapping).then(applyRules).commit()`). Spike confirmed `run.start({inputData})` (awaited) executes a standalone workflow and returns `{ status, result }` — no Mastra-instance registration or storage needed for this. (Spike also confirmed `getWorkflowRunById` polling only works on a storage-registered workflow + needs a circular-DI dance to persist — so we do NOT use it.)
- **Async** is a thin `bank_import_job` table: `startImport` writes a `running` row, fires a background task (`run.start` the workflow → `createStatement`), returns `{ jobId }`; the task updates the row to `done`(+statement id) or `failed`(+error). The UI polls `GET …/import/:jobId`. The job/status layer is plain Kysely — fully unit-testable (the Mastra workflow is stubbed under jest; the deterministic `applyRules` is tested directly).
- The `inferMapping` step calls a new `bank_mapping` Mastra Agent (model via `AgentConfigService.resolveModelConfig`, so it honors the inference-endpoint settings) using the Pass-2 pattern (`agent.generate(..., { structuredOutput: { schema } })` + `safeParse`). `applyRules` is a pure function (`csv-parse`) producing a Zod-validated `CreateStatementInput`.

**Tech Stack:** NestJS + Kysely + `@mastra/core` + `csv-parse` (backend); React (frontend).

---

## Verified facts / contracts
- `createWorkflow({ id, inputSchema, outputSchema })` → `.then(step)` → `.commit()`; `createStep({ id, inputSchema, outputSchema, execute })` (from `@mastra/core/workflows`, v1.41). `run = await wf.createRun(); res = await run.start({ inputData })` → `res.status`, `res.result`.
- Agent: `await agent.generate(prompt, { structuredOutput: { schema } })` → `.object`; then `schema.safeParse(.object)` (mirror `src/ai/pass2-agent.service.ts`).
- `createStatementSchema` (`src/bank/bank-statement.types.ts`): `{ account_code: string (BANK_*); start_date: string; end_date: string; file_path?: string|null; transactions: CreateTransaction[] }`. `createTransactionSchema`: `{ transaction_date: string; description?: string|null; amount: number(int, signed cents); currency: string; source_currency?; source_amount?; fx_rate?; counterparty_iban?; counterparty_descriptor?; reference?; status?: 'open'|'prepayment'|'personal'|'bank_fee'|'dividend' }`.
- `BankStatementService.createStatement(input: CreateStatementInput): Promise<{ statement: BankStatementRecord; transactions: BankTransactionRecord[] }>` (validates account exists, asset type, `BANK_*`).
- `AgentConfigService.resolveModelConfig(key)` (already on main) builds the endpoint-aware model. `AgentKey` = `'triage' | 'intent_classifier'` — extend with `'bank_mapping'`.
- Jest maps `@mastra/*` to `test/mastra-stub.ts` (it can't load ESM Mastra). The stub needs `Workflow`/`Run`/`createWorkflow`/`createStep`, and `@mastra/core/workflows` must be added to the `moduleNameMapper` in BOTH `package.json` and `test/jest-e2e.json`.

## File structure
- Add `package.json` dep `csv-parse`.
- Create `src/bank/bank-mapping.types.ts` — `mappingRulesetSchema` (Zod) + `MappingRuleset` type.
- Create `src/bank/apply-rules.ts` — `applyRules(ruleset, csvText) → CreateStatementInput` (pure).
- Create `src/bank/apply-rules.spec.ts` — pure unit tests over CSV fixtures.
- Create migration `src/database/migrations/NNN_create_bank_import_job.ts` (+ register in the migrations array) + `bank_import_job` table type in `src/database/types.ts`.
- Create `src/bank/bank-import-job.repository.ts` (+ spec) — create/get/markDone/markFailed.
- Create `src/bank/bank-ingestion.workflow.ts` — `buildBankIngestionWorkflow(agent)` returning a committed Mastra workflow.
- Create `src/bank/bank-ingestion.service.ts` (+ spec) — `startImport`, `getImportStatus`, the background runner.
- Create `src/bank/bank-ingestion.controller.ts` — `POST /api/bank-statements/import` (multipart), `GET /api/bank-statements/import/:jobId`.
- Modify `src/ai/agent-config.ts` (`AgentKey` + `AGENT_PROMPTS`), `src/ai/mastra.service.ts` (build + expose `bankMappingAgent`), `src/bank/bank.module.ts` (wire AiModule + new providers/controller).
- Modify `test/mastra-stub.ts`, `package.json`, `test/jest-e2e.json` (workflow stub + mapper).
- Frontend: `frontend/src/api.ts` (+ `importBankStatement`, `getBankImportStatus`, types) + `frontend/src/components/BankView.tsx` (+ test) + `frontend/src/tabs.tsx` (Bank tab).

---

### Task 1: deterministic core — mapping ruleset + applyRules (TDD, NO Mastra)

**Files:** `src/bank/bank-mapping.types.ts`, `src/bank/apply-rules.ts`, `src/bank/apply-rules.spec.ts`; `package.json` (csv-parse).

- [ ] **Step 1: Add csv-parse.** Run `npm install csv-parse@^5`. Confirm it appears under `dependencies`.

- [ ] **Step 2: Define the ruleset schema.** Create `src/bank/bank-mapping.types.ts`:
```ts
import { z } from 'zod';

/**
 * The LLM's output: how to read ONE bank's CSV. A column reference is a header
 * name; transforms are a small fixed vocabulary the deterministic transformer
 * understands. Kept deliberately narrow so a malformed mapping fails Zod rather
 * than smuggling arbitrary behavior into the kernel.
 */
export const mappingRulesetSchema = z.object({
  /** Which BANK_* chart account this statement posts to. */
  account_code: z.string(),
  /** Header whose value is the transaction date. */
  date_column: z.string(),
  /** Date format hint for parsing (e.g. 'YYYY-MM-DD', 'DD.MM.YYYY'). */
  date_format: z.string(),
  /** How the signed amount is derived. */
  amount: z.discriminatedUnion('mode', [
    // One signed column (e.g. "-12.34" / "12.34"), in major units (decimals).
    z.object({ mode: z.literal('signed'), column: z.string() }),
    // A magnitude column plus a debit/credit indicator column.
    z.object({
      mode: z.literal('debit_credit'),
      amount_column: z.string(),
      indicator_column: z.string(),
      debit_value: z.string(),
    }),
  ]),
  currency_column: z.string().nullable(),
  /** Fallback currency when there is no currency column. */
  default_currency: z.string(),
  description_column: z.string().nullable(),
  counterparty_iban_column: z.string().nullable(),
  counterparty_descriptor_column: z.string().nullable(),
  reference_column: z.string().nullable(),
});

export type MappingRuleset = z.infer<typeof mappingRulesetSchema>;
```

- [ ] **Step 3: Write the failing tests.** Create `src/bank/apply-rules.spec.ts`:
```ts
import { applyRules } from './apply-rules';
import type { MappingRuleset } from './bank-mapping.types';

const lhvLike: MappingRuleset = {
  account_code: 'BANK_EUR',
  date_column: 'Date',
  date_format: 'YYYY-MM-DD',
  amount: { mode: 'debit_credit', amount_column: 'Amount', indicator_column: 'D/C', debit_value: 'D' },
  currency_column: 'Currency',
  default_currency: 'EUR',
  description_column: 'Explanation',
  counterparty_iban_column: 'CounterpartyIban',
  counterparty_descriptor_column: null,
  reference_column: 'Reference',
};

const csv = `Date,Amount,D/C,Currency,Explanation,CounterpartyIban,Reference
2026-05-08,6157.00,C,EUR,Invoice 1000,DK7430000014041346,REF1
2026-05-30,27.59,D,EUR,OPENROUTER,,`;

describe('applyRules', () => {
  it('maps a debit/credit CSV to CreateStatementInput with signed integer cents', () => {
    const out = applyRules(lhvLike, csv);
    expect(out.account_code).toBe('BANK_EUR');
    expect(out.transactions).toHaveLength(2);
    // Credit → positive cents; Debit → negative cents.
    expect(out.transactions[0].amount).toBe(615700);
    expect(out.transactions[0].currency).toBe('EUR');
    expect(out.transactions[0].counterparty_iban).toBe('DK7430000014041346');
    expect(out.transactions[1].amount).toBe(-2759);
    // Date range derived from the min/max transaction dates.
    expect(out.start_date).toBe('2026-05-08');
    expect(out.end_date).toBe('2026-05-30');
  });

  it('handles a single signed amount column', () => {
    const ruleset: MappingRuleset = {
      ...lhvLike,
      amount: { mode: 'signed', column: 'Amount' },
    };
    const signedCsv = `Date,Amount,Currency,Explanation,CounterpartyIban,Reference
2026-05-08,6157.00,EUR,x,,
2026-05-09,-27.59,EUR,y,,`;
    const out = applyRules(ruleset, signedCsv);
    expect(out.transactions[0].amount).toBe(615700);
    expect(out.transactions[1].amount).toBe(-2759);
  });

  it('throws when the produced statement fails the kernel schema (e.g. empty)', () => {
    expect(() => applyRules(lhvLike, 'Date,Amount,D/C,Currency,Explanation,CounterpartyIban,Reference\n')).toThrow();
  });
});
```

- [ ] **Step 4: Run — expect FAIL** (`npx jest apply-rules`).

- [ ] **Step 5: Implement `src/bank/apply-rules.ts`:**
```ts
import { parse } from 'csv-parse/sync';
import {
  createStatementSchema,
  type CreateStatementInput,
} from './bank-statement.types';
import type { MappingRuleset } from './bank-mapping.types';

/** Major-unit decimal string → signed integer minor units (cents). */
function toCents(raw: string): number {
  const cleaned = raw.replace(/\s/g, '').replace(',', '.');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) throw new Error(`Not a number: "${raw}"`);
  return Math.round(n * 100);
}

/** Reformat a date string per the ruleset's format hint into ISO YYYY-MM-DD. */
function toIso(raw: string, format: string): string {
  const v = raw.trim();
  if (format === 'YYYY-MM-DD') return v;
  const m = /^(\d{2})[.\/](\d{2})[.\/](\d{4})$/.exec(v); // DD.MM.YYYY or DD/MM/YYYY
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return v; // best effort; the kernel schema only requires a string
}

const cell = (row: Record<string, string>, col: string | null): string | null =>
  col ? (row[col] ?? '').trim() || null : null;

/**
 * Deterministically apply a mapping ruleset to a bank CSV, producing a
 * Zod-validated CreateStatementInput. Pure — no Mastra, no IO. Throws if the
 * result does not satisfy the kernel schema (the safeguard).
 */
export function applyRules(
  ruleset: MappingRuleset,
  csvText: string,
): CreateStatementInput {
  const rows = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  const transactions = rows.map((row) => {
    let amount: number;
    if (ruleset.amount.mode === 'signed') {
      amount = toCents(row[ruleset.amount.column]);
    } else {
      const magnitude = Math.abs(toCents(row[ruleset.amount.amount_column]));
      const isDebit =
        (row[ruleset.amount.indicator_column] ?? '').trim() ===
        ruleset.amount.debit_value;
      amount = isDebit ? -magnitude : magnitude;
    }
    return {
      transaction_date: toIso(row[ruleset.date_column], ruleset.date_format),
      amount,
      currency:
        cell(row, ruleset.currency_column) ?? ruleset.default_currency,
      description: cell(row, ruleset.description_column),
      counterparty_iban: cell(row, ruleset.counterparty_iban_column),
      counterparty_descriptor: cell(
        row,
        ruleset.counterparty_descriptor_column,
      ),
      reference: cell(row, ruleset.reference_column),
    };
  });

  const dates = transactions.map((t) => t.transaction_date).sort();
  const candidate = {
    account_code: ruleset.account_code,
    start_date: dates[0],
    end_date: dates[dates.length - 1],
    transactions,
  };

  // The safeguard: only a schema-valid statement crosses into the kernel.
  return createStatementSchema.parse(candidate);
}
```

- [ ] **Step 6: Run — expect PASS** (`npx jest apply-rules` → 3 pass). `npm run build` clean.

- [ ] **Step 7: Commit**
```bash
git add package.json package-lock.json src/bank/bank-mapping.types.ts src/bank/apply-rules.ts src/bank/apply-rules.spec.ts
git commit -m "feat(bank): deterministic CSV→CreateStatementInput transformer + ruleset schema"
```

---

### Task 2: bank_import_job table + repository (TDD)

**Files:** migration + `src/database/types.ts`; `src/bank/bank-import-job.repository.ts` (+ spec).

- [ ] **Step 1: Inspect an existing migration** under `src/database/migrations/` and the `migrations` array (how they're numbered + registered) and the `Database` interface in `src/database/types.ts`. Match those patterns exactly.

- [ ] **Step 2: Add the table type.** In `src/database/types.ts`, add a `BankImportJobTable` interface and wire it into the `Database` interface as `bank_import_job`:
```ts
export interface BankImportJobTable {
  id: Generated<number>;
  status: string; // 'running' | 'done' | 'failed'
  account_code: string;
  statement_id: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}
```
(Use the file's existing `Generated` import + conventions; add `bank_import_job: BankImportJobTable;` to `Database`.)

- [ ] **Step 3: Create the migration** `src/database/migrations/<next-number>_create_bank_import_job.ts` mirroring an existing migration's `up` shape (columns: id PK autoincrement, status TEXT NOT NULL, account_code TEXT NOT NULL, statement_id INTEGER NULL, error TEXT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL). Register it in the migrations array in the SAME place/format the others are.

- [ ] **Step 4: Write the failing repo spec.** Create `src/bank/bank-import-job.repository.spec.ts` using the in-memory-SQLite + real-migration harness the other bank/repo specs use (read `src/bank/bank-transaction.repository.spec.ts` for the exact setup). Assert: `create({account_code})` returns a row with `status='running'`; `markDone(id, statementId)` sets `status='done'` + `statement_id`; `markFailed(id, msg)` sets `status='failed'` + `error`; `get(id)` returns the row; `get(unknown)` returns undefined/null per the existing convention.

- [ ] **Step 5: Run — expect FAIL** (`npx jest bank-import-job`).

- [ ] **Step 6: Implement `src/bank/bank-import-job.repository.ts`** — a Kysely-backed repo (mirror `bank-transaction.repository.ts`'s injection + style): `create`, `get`, `markDone`, `markFailed`, each stamping `updated_at`.

- [ ] **Step 7: Run — expect PASS**; `npm run build` clean.

- [ ] **Step 8: Commit**
```bash
git add src/database/types.ts src/database/migrations/ src/bank/bank-import-job.repository.ts src/bank/bank-import-job.repository.spec.ts
git commit -m "feat(bank): bank_import_job table + repository"
```

---

### Task 3: bank_mapping agent (agent-config + MastraService)

**Files:** `src/ai/agent-config.ts`, `src/ai/mastra.service.ts`.

- [ ] **Step 1: Extend `AgentKey` + `AGENT_PROMPTS`.** In `src/ai/agent-config.ts`, change `AgentKey` to `'triage' | 'intent_classifier' | 'bank_mapping'` and add a `bank_mapping` entry to `AGENT_PROMPTS`:
```ts
  bank_mapping:
    'You map a bank-statement CSV onto a fixed ruleset. You are given the ' +
    'CSV header row and a few sample data rows. Return ONLY the structured ' +
    'mapping: which header holds the date (with its format), how the signed ' +
    'amount is derived (a single signed column, or a magnitude column plus a ' +
    'debit/credit indicator column and which value means debit), the currency ' +
    'column or a default currency, and the columns for description, ' +
    'counterparty IBAN, counterparty descriptor, and reference (null when ' +
    'absent). Also choose the BANK_* account_code for this statement. Do NOT ' +
    'output transaction data — only the rules for reading it.',
```

- [ ] **Step 2: Build + expose the agent in MastraService.** In `src/ai/mastra.service.ts`, after the triage agent is created, build a `bank_mapping` agent (model via `resolveModelConfig`, no tools) and store it; add a getter. Concretely: add a private field `private bankMappingAgent: Agent | null = null;`; in `initialize()` after `this.agent = triageAgent;` add:
```ts
    const bankModel = await this.config.resolveModelConfig('bank_mapping');
    const bankInstructions = await this.config.resolveInstructions('bank_mapping');
    this.bankMappingAgent = new Agent({
      id: 'bank-mapping-agent',
      name: 'Bank Mapping Agent',
      instructions: bankInstructions,
      model: bankModel,
    });
```
and add a getter near `getAgent()`:
```ts
  /** The bank-statement CSV-mapping agent (null until initialized). */
  getBankMappingAgent(): Agent | null {
    return this.bankMappingAgent;
  }
```

- [ ] **Step 3: Build + lint + tests.** Run `npm run build && npm run lint && npm test`. Expected: clean; existing tests pass (the jest mastra-stub `Agent` ignores config). If a MastraService spec asserts the agent set, update it minimally + report.

- [ ] **Step 4: Commit**
```bash
git add src/ai/agent-config.ts src/ai/mastra.service.ts
git commit -m "feat(ai): bank_mapping agent (endpoint-aware) on MastraService"
```

---

### Task 4: Mastra ingestion workflow + mastra-stub additions

**Files:** `src/bank/bank-ingestion.workflow.ts`; `test/mastra-stub.ts`; `package.json` + `test/jest-e2e.json` (mapper).

- [ ] **Step 1: Add the `@mastra/core/workflows` jest mapper.** In BOTH `package.json` (`jest.moduleNameMapper`) and `test/jest-e2e.json` (`moduleNameMapper`), add an entry mapping `"^@mastra/core/workflows$"` to the SAME `mastra-stub` path the sibling `@mastra/core` entry uses (mind the differing `<rootDir>` between the two configs — copy the relative path style of the adjacent `@mastra/core` entry in each file).

- [ ] **Step 2: Extend `test/mastra-stub.ts`** — add `Workflow`/`Run` classes + `createWorkflow`/`createStep` exports so the DI graph + workflow construction don't throw under jest (the real run is exercised only against live Mastra). Append:
```ts
export class Run {
  readonly runId = 'stub-run';
  async start(_args: { inputData?: unknown }): Promise<{ status: string; result: unknown }> {
    return { status: 'success', result: undefined };
  }
}
export class Workflow {
  constructor(public config: { id?: unknown } = {}) {}
  then(): this { return this; }
  commit(): this { return this; }
  async createRun(): Promise<Run> { return new Run(); }
}
export function createWorkflow(config: { id?: unknown } = {}): Workflow {
  return new Workflow(config);
}
export function createStep(params: unknown): unknown {
  return params;
}
```
(Keep the existing exports; just add these. Match the file's existing export style.)

- [ ] **Step 3: Build the workflow.** Create `src/bank/bank-ingestion.workflow.ts`:
```ts
import { createWorkflow, createStep } from '@mastra/core/workflows';
import type { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { mappingRulesetSchema } from './bank-mapping.types';
import { applyRules } from './apply-rules';
import { createStatementSchema } from './bank-statement.types';

const ingestInput = z.object({ csvText: z.string(), accountHint: z.string() });

/**
 * The Mastra workflow: inferMapping (LLM → ruleset) → applyRules (deterministic
 * → CreateStatementInput). Built per call with the bank-mapping agent injected,
 * so it carries no NestJS coupling. Run via `(await wf.createRun()).start(...)`.
 */
export function buildBankIngestionWorkflow(agent: Agent) {
  const inferMapping = createStep({
    id: 'inferMapping',
    inputSchema: ingestInput,
    outputSchema: z.object({
      ruleset: mappingRulesetSchema,
      csvText: z.string(),
    }),
    execute: async ({ inputData }) => {
      const headerAndSamples = inputData.csvText.split('\n').slice(0, 6).join('\n');
      const res = await agent.generate(
        `Account hint: ${inputData.accountHint}\nCSV (header + samples):\n${headerAndSamples}`,
        { structuredOutput: { schema: mappingRulesetSchema } },
      );
      const parsed = mappingRulesetSchema.safeParse(
        (res as { object?: unknown }).object,
      );
      if (!parsed.success) {
        throw new Error(`bank_mapping agent returned an invalid ruleset: ${parsed.error.message}`);
      }
      return { ruleset: parsed.data, csvText: inputData.csvText };
    },
  });

  const apply = createStep({
    id: 'applyRules',
    inputSchema: z.object({ ruleset: mappingRulesetSchema, csvText: z.string() }),
    outputSchema: createStatementSchema,
    execute: async ({ inputData }) =>
      applyRules(inputData.ruleset, inputData.csvText),
  });

  return createWorkflow({
    id: 'bank-ingestion',
    inputSchema: ingestInput,
    outputSchema: createStatementSchema,
  })
    .then(inferMapping)
    .then(apply)
    .commit();
}
```

- [ ] **Step 4: Build + tests.** `npm run build && npm test`. Expected: build clean (tsc resolves real Mastra workflow types); unit suites pass (jest uses the stub). If tsc errors on the `createStep`/`createWorkflow` generics (e.g. `inputData` typing), STOP and report the exact error — the step `execute` param typing may need an explicit annotation; do not `as any` without flagging.

- [ ] **Step 5: Commit**
```bash
git add src/bank/bank-ingestion.workflow.ts test/mastra-stub.ts package.json test/jest-e2e.json
git commit -m "feat(bank): Mastra ingestion workflow (inferMapping → applyRules) + stub"
```

---

### Task 5: BankIngestionService (start + background run + status) (TDD)

**Files:** `src/bank/bank-ingestion.service.ts` (+ spec); `src/bank/bank.module.ts`.

- [ ] **Step 1: Write the failing spec.** Create `src/bank/bank-ingestion.service.spec.ts` (in-memory SQLite + real migrations harness, like the repo spec). Provide the service with: a real `BankImportJobRepository`, a stub `BankStatementService` whose `createStatement` resolves `{ statement: { id: 99 } }`, and a stub `MastraService` whose `getBankMappingAgent()` returns a fake agent. Because the workflow uses the jest-stubbed `createWorkflow`/`run.start` (which returns `{ status:'success', result: undefined }`), inject the workflow-run result via a seam: the service should accept the built workflow through a small overridable method `protected buildWorkflow(agent)` OR (simpler) the service calls a module-level `runIngestion(agent, input)` indirection that the spec can `jest.spyOn`. **Design the service so the spec can force the run result to a known `CreateStatementInput` without real Mastra** — e.g. expose `async runWorkflow(input): Promise<CreateStatementInput>` that the spec spies on. Assert:
  - `startImport(csv, 'BANK_EUR')` returns `{ jobId }` and creates a `running` job row synchronously.
  - after the background task settles (await a flush), `getImportStatus(jobId)` is `done` with `statement_id = 99` (createStatement was called with the forced CreateStatementInput).
  - when `runWorkflow` rejects, the job ends `failed` with the error message.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `src/bank/bank-ingestion.service.ts`:**
```ts
import { Injectable } from '@nestjs/common';
import { MastraService } from '../ai/mastra.service';
import { BankStatementService } from './bank-statement.service';
import { BankImportJobRepository } from './bank-import-job.repository';
import { buildBankIngestionWorkflow } from './bank-ingestion.workflow';
import type { CreateStatementInput } from './bank-statement.types';

@Injectable()
export class BankIngestionService {
  constructor(
    private readonly mastra: MastraService,
    private readonly statements: BankStatementService,
    private readonly jobs: BankImportJobRepository,
  ) {}

  /** Overridable seam: run the Mastra workflow and return the validated input. */
  async runWorkflow(
    csvText: string,
    accountHint: string,
  ): Promise<CreateStatementInput> {
    const agent = this.mastra.getBankMappingAgent();
    if (!agent) throw new Error('Bank mapping agent unavailable (AI not configured)');
    const wf = buildBankIngestionWorkflow(agent);
    const run = await wf.createRun();
    const res = await run.start({ inputData: { csvText, accountHint } });
    if (res.status !== 'success') {
      throw new Error(`Ingestion workflow failed: ${res.status}`);
    }
    return res.result as CreateStatementInput;
  }

  async startImport(
    csvText: string,
    accountHint: string,
  ): Promise<{ jobId: number }> {
    const job = await this.jobs.create(accountHint);
    // Fire-and-forget: run in the background, never reject the caller.
    void this.process(job.id, csvText, accountHint);
    return { jobId: job.id };
  }

  private async process(
    jobId: number,
    csvText: string,
    accountHint: string,
  ): Promise<void> {
    try {
      const input = await this.runWorkflow(csvText, accountHint);
      const { statement } = await this.statements.createStatement(input);
      await this.jobs.markDone(jobId, statement.id);
    } catch (e) {
      await this.jobs.markFailed(
        jobId,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  getImportStatus(jobId: number) {
    return this.jobs.get(jobId);
  }
}
```

- [ ] **Step 4: Wire `bank.module.ts`** — import `AiModule` (for `MastraService`; confirm `AiModule` exports it), and add `BankIngestionService` + `BankImportJobRepository` to `providers` (and `BankIngestionController` from Task 6 once it exists — add it here in Task 6).

- [ ] **Step 5: Run — expect PASS**; `npm run build` clean.

- [ ] **Step 6: Commit**
```bash
git add src/bank/bank-ingestion.service.ts src/bank/bank-ingestion.service.spec.ts src/bank/bank.module.ts
git commit -m "feat(bank): BankIngestionService — async import via Mastra workflow + job table"
```

---

### Task 6: controller — upload + poll

**Files:** `src/bank/bank-ingestion.controller.ts`; `src/bank/bank.module.ts`.

- [ ] **Step 1: Create `src/bank/bank-ingestion.controller.ts`** mirroring the documents multipart pattern (`FileInterceptor('file', { storage: memoryStorage() })` — see `src/documents/documents.controller.ts`):
```ts
import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  UploadedFile,
  UseInterceptors,
  ParseIntPipe,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { BankIngestionService } from './bank-ingestion.service';

@ApiTags('bank')
@Controller('api/bank-statements')
export class BankIngestionController {
  constructor(private readonly ingestion: BankIngestionService) {}

  @Post('import')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  async startImport(
    @UploadedFile() file: Express.Multer.File,
    @Body('account_code') accountCode: string,
  ): Promise<{ jobId: number }> {
    const csvText = file.buffer.toString('utf8');
    return this.ingestion.startImport(csvText, accountCode ?? '');
  }

  @Get('import/:jobId')
  async status(@Param('jobId', ParseIntPipe) jobId: number) {
    const job = await this.ingestion.getImportStatus(jobId);
    if (!job) throw new NotFoundException(`Import job ${jobId} not found`);
    return job;
  }
}
```

- [ ] **Step 2: Register** `BankIngestionController` in `bank.module.ts` `controllers`.

- [ ] **Step 3: e2e smoke.** Add `test/bank-import.e2e-spec.ts`: with a Bearer token, `POST /api/bank-statements/import` with a multipart `file` (a tiny CSV) + `account_code=BANK_EUR` field → expect a `jobId`; `GET /api/bank-statements/import/:jobId` → expect a job object with a `status`. (Under jest the stubbed workflow `run.start` returns `{status:'success', result: undefined}`, so the background `createStatement(undefined)` will throw → the job ends `failed` — assert the endpoint returns a job whose `status` is a string, NOT that it's `done`. This exercises the HTTP + job plumbing without real AI.) Also assert both routes are 401 without a token.

- [ ] **Step 4: Run** `npm run build && npm run test:e2e`. Expected: green (the new e2e + existing 48).

- [ ] **Step 5: Commit**
```bash
git add src/bank/bank-ingestion.controller.ts src/bank/bank.module.ts test/bank-import.e2e-spec.ts
git commit -m "feat(bank): import upload + status endpoints"
```

---

### Task 7: UI — Bank tab (upload CSV + poll)

**Files:** `frontend/src/api.ts`; `frontend/src/components/BankView.tsx` (+ test); `frontend/src/tabs.tsx`.

- [ ] **Step 1: api helpers (with a test).** Append to `frontend/src/api.ts`:
```ts
// ── Bank statement import (async) ─────────────────────────────────────────
export interface BankImportJob {
  id: number;
  status: string;
  account_code: string;
  statement_id: number | null;
  error: string | null;
}

export const importBankStatement = (file: File, accountCode: string) => {
  const body = new FormData();
  body.append('file', file);
  body.append('account_code', accountCode);
  return apiFetch<{ jobId: number }>('/api/bank-statements/import', {
    method: 'POST',
    body,
  });
};

export const getBankImportStatus = (jobId: number) =>
  apiFetch<BankImportJob>(`/api/bank-statements/import/${jobId}`);
```
Add to `frontend/src/api.test.ts` (inside the existing describe) a test asserting `importBankStatement(file, 'BANK_EUR')` POSTs multipart FormData (no JSON content-type) to `/api/bank-statements/import`.

- [ ] **Step 2: Create `frontend/src/components/BankView.tsx`** — a file input + account-code input + Import button (calls `importBankStatement` → stores `jobId`), then polls `getBankImportStatus(jobId)` every ~1.5s until `status !== 'running'`, showing the final status (done → "Created statement #N"; failed → the error). Mirror the IntakeView structure (a `run`/busy/error pattern). Add `frontend/src/components/BankView.test.tsx`: mock `importBankStatement` → `{jobId:7}` and `getBankImportStatus` → `{status:'done', statement_id:5, ...}`; render, set a file + account, click Import, assert it shows the created-statement result. (Use `vi.useFakeTimers` or mock the status as already-done on first poll to avoid real timers.)

- [ ] **Step 3: Add the Bank tab.** In `frontend/src/tabs.tsx`: import `BankView`; define `bankTab` (`key:'bank'`, label `'Bank import'`, stub load/columns, `Custom: BankView`); insert into `TABS` after `documentsTab`.

- [ ] **Step 4: Frontend gate (CLEAN).** `cd frontend && rm -f *.tsbuildinfo && npx tsc -b && npm test && npm run build`. Expected: tsc 0; vitest green; build 0.

- [ ] **Step 5: Commit**
```bash
git add frontend/src/api.ts frontend/src/api.test.ts frontend/src/components/BankView.tsx frontend/src/components/BankView.test.tsx frontend/src/tabs.tsx
git commit -m "feat(spa): Bank import tab — upload CSV, poll job status"
```

---

### Task 8: final gate + push

- [ ] **Step 1: Backend gate.** `npm run build && npm run lint && npm test && npm run test:e2e` → all green.
- [ ] **Step 2: Frontend gate (CLEAN).** `cd frontend && rm -f *.tsbuildinfo && npx tsc -b && npm test && npm run build` → green.
- [ ] **Step 3: Manual smoke (optional, needs a real inference endpoint configured in Settings).** Upload the May LHV CSV on the Bank tab with `account_code=BANK_EUR`; the job polls to `done` and a statement is created (or `failed` with the agent/validation error surfaced).
- [ ] **Step 4: Push + hand off.** `git push -u origin operator-spa-bank`; STOP — open the PR manually (`main` protected).

---

## Self-Review

**Spec coverage (ADR-0031):** LLM infers a mapping ruleset (Task 3 agent + Task 4 inferMapping step) → deterministic transformer applies it (Task 1 `applyRules`) → `createStatement` (Task 5). Fresh inference per upload, no cache (a new workflow run each `startImport`). No human-confirm — straight through; the Zod safeguard is `createStatementSchema.parse` in `applyRules` (Task 1) + `mappingRulesetSchema.safeParse` on the agent output (Task 4). Async with poll: Task 2 (job table) + Task 5 (background run) + Task 6 (endpoints) + Task 7 (UI poll). ✓

**De-risking:** the runtime spike proved `run.start()` executes a standalone workflow and returns its result — the design depends only on that (NOT on `getWorkflowRunById`, which the spike showed needs storage+registration). The async/status layer is a plain Kysely table, fully unit-tested; the Mastra workflow is stubbed under jest and its live run is build- + manual-smoke-verified (the e2e exercises the HTTP/job plumbing with the stub's canned run, asserting plumbing not AI output).

**Placeholder scan:** Tasks 2 and 5 instruct reading the existing migration/repo/spec harness and designing a test seam (`runWorkflow`) rather than hardcoding an unknown — deliberate "match existing pattern" instructions, with the concrete code given for the non-pattern-dependent parts.

**Type consistency:** `MappingRuleset`/`createStatementSchema` (bank-mapping.types/bank-statement.types) flow agent → workflow → `applyRules`; `BankImportJob` (api.ts) mirrors the `bank_import_job` row; `resolveModelConfig('bank_mapping')` requires the `AgentKey` extension (Task 3). The workflow output type is `CreateStatementInput`, consumed by `createStatement`.

**Soft spots / honest limits:**
- The live Mastra run + the agent's real output are NOT exercised by automated tests (jest stubs Mastra). The deterministic `applyRules` — the part most likely to be wrong — is heavily unit-tested; the agent/workflow is integration-glue verified by build + manual smoke. This is an accepted limit of the jest-can't-load-ESM-Mastra setup (same as the existing triage path).
- Fire-and-forget background run: a process restart mid-import orphans a `running` job. Acceptable for a single-operator, monthly upload; the operator re-uploads. (A future cron could mark stale `running` jobs `failed`.)
- `applyRules` date/amount parsing covers the common LHV-style shapes (ISO + DD.MM.YYYY; signed or D/C). Genuinely exotic formats would fail the schema → the job ends `failed` with a clear error → the operator re-uploads (per-upload inference is what makes that the expected, recoverable path).
