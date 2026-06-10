# Inference endpoint config (base URL + API key) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`). **Verification note:** the frontend `tsc -b` is incremental — delete `frontend/*.tsbuildinfo` before any "type-check green" claim so it matches a clean CI build.

**Goal:** Let the operator point LLM inference at a chosen OpenAI-compatible endpoint (OpenRouter, self-hosted, …) by setting a **base URL** and **API key** in Settings — today only the model id is configurable and the URL/key are nowhere settable (the bare model string is resolved by Mastra's gateway against provider defaults + process env, so real inference can't be aimed anywhere).

**Architecture:** Mastra's `Agent` `model` field accepts an `OpenAICompatibleConfig` object `{ id: \`provider/model\`; url?; apiKey? }` (verified in `@mastra/core@1.41` `llm/model/shared.types.d.ts`). `AgentConfigService` gains `resolveModelConfig(key)`: it returns the bare model-id string when no `ai_base_url` is set (gateway default, unchanged behavior), or the config object `{ id, url, apiKey? }` when a base URL is set. Both Agent build sites (`MastraService` triage agent, `IntentClassifierService`) switch to it. Two new validated settings (`ai_base_url`, `ai_api_key`) drive it, surfaced on the Settings page (key as a password field).

**Tech Stack:** NestJS + Kysely + `@mastra/core` (backend); React + Vitest (frontend).

---

## Verified facts
- Mastra `Agent` `model` accepts `MastraModelConfig`, which includes `OpenAICompatibleConfig = { id: \`${string}/${string}\`; url?: string; apiKey?: string; headers?: Record<string,string> }` (`node_modules/@mastra/core/dist/llm/model/shared.types.d.ts:23`). A bare `ModelRouterModelId` string is also accepted (current behavior).
- Agent is constructed in exactly two places: `src/ai/mastra.service.ts` (triage agent) and `src/interaction/router/intent-classifier.service.ts`. Both read the model from `AgentConfigService`.
- `AgentConfigService.resolveModel(key)` returns the string id (`ai_model.<key>` → `ai_model` → `DEFAULT_MODEL='openai/gpt-4o-mini'`); existing tests assert this string return — DO NOT change it. Add a separate `resolveModelConfig`.
- The settings registry (`src/admin/settings.registry.ts`) is the allowlist; an unknown key/invalid value → 400.

## File Structure
- Modify `src/ai/agent-config.ts` — add `ModelConfig` type.
- Modify `src/ai/agent-config.service.ts` — add `resolveModelConfig(key)`.
- Modify `src/ai/agent-config.service.spec.ts` — TDD for `resolveModelConfig`.
- Modify `src/admin/settings.registry.ts` — add `ai_base_url`, `ai_api_key`.
- Modify `src/ai/mastra.service.ts` — triage agent uses `resolveModelConfig`.
- Modify `src/interaction/router/intent-classifier.service.ts` — uses `resolveModelConfig`.
- Modify `frontend/src/components/SettingsView.tsx` — `secret` field support + two new LLM keys.

---

### Task 1: AgentConfigService.resolveModelConfig (TDD)

**Files:** `src/ai/agent-config.ts`, `src/ai/agent-config.service.ts`, `src/ai/agent-config.service.spec.ts`.

- [ ] **Step 1: Add the `ModelConfig` type.** In `src/ai/agent-config.ts`, after the `ResolvedAgentConfig` interface, add:
```ts
/**
 * What an Agent's `model` is given. A bare provider/model id (resolved by
 * Mastra's gateway against provider defaults) when no custom endpoint is set,
 * or an OpenAI-compatible config aiming inference at a chosen base URL + key.
 */
export type ModelConfig =
  | string
  | { id: `${string}/${string}`; url: string; apiKey?: string };
```

- [ ] **Step 2: Write the failing tests.** In `src/ai/agent-config.service.spec.ts`, add a `describe('resolveModelConfig')` block (place it after the existing tests, inside the top-level describe). Use the same DB/seed harness the existing tests use (insert into the `setting` table). Tests:
```ts
  describe('resolveModelConfig', () => {
    it('returns the bare model id string when no ai_base_url is set', async () => {
      await expect(config.resolveModelConfig('triage')).resolves.toBe(
        DEFAULT_MODEL,
      );
    });

    it('returns an OpenAI-compatible object with url + apiKey when both set', async () => {
      await setSetting('ai_base_url', 'https://openrouter.ai/api/v1');
      await setSetting('ai_api_key', 'sk-test');
      await setSetting('ai_model', 'anthropic/claude-3-5');
      await expect(config.resolveModelConfig('triage')).resolves.toEqual({
        id: 'anthropic/claude-3-5',
        url: 'https://openrouter.ai/api/v1',
        apiKey: 'sk-test',
      });
    });

    it('omits apiKey when only ai_base_url is set', async () => {
      await setSetting('ai_base_url', 'http://localhost:1234/v1');
      await expect(config.resolveModelConfig('triage')).resolves.toEqual({
        id: DEFAULT_MODEL,
        url: 'http://localhost:1234/v1',
      });
    });
  });
```
NOTE: read the existing spec first to reuse its exact seed helper. If it inserts settings inline (e.g. `db.insertInto('setting').values({key,value})`) rather than a `setSetting` helper, define a local `setSetting(key,value)` wrapper at the top of the new describe (or inline the inserts) to match the existing harness — do NOT invent an import that isn't there.

- [ ] **Step 3: Run — expect FAIL**
Run: `npx jest agent-config.service`
Expected: FAIL — `resolveModelConfig` is not a function.

- [ ] **Step 4: Implement `resolveModelConfig`.** In `src/ai/agent-config.service.ts`, import the type:
```ts
import { AGENT_PROMPTS, DEFAULT_MODEL, type AgentKey, type ModelConfig } from './agent-config';
```
(merge with the existing import from `./agent-config` — keep whatever is already imported). Then add this method (after `resolveModel`):
```ts
  /**
   * The full model config for an Agent: a bare id string (gateway default) when
   * no `ai_base_url` is set, else an OpenAI-compatible object aiming inference at
   * that base URL with the optional `ai_api_key`.
   */
  async resolveModelConfig(key: AgentKey): Promise<ModelConfig> {
    const id = await this.resolveModel(key);
    const url = await this.read('ai_base_url');
    if (!url) return id;
    const apiKey = await this.read('ai_api_key');
    return {
      // model ids are `provider/model`; the gateway/compat layer needs the slash.
      id: id as `${string}/${string}`,
      url,
      ...(apiKey ? { apiKey } : {}),
    };
  }
```

- [ ] **Step 5: Run — expect PASS**
Run: `npx jest agent-config.service`
Expected: PASS (existing + 3 new).

- [ ] **Step 6: Commit**
```bash
git add src/ai/agent-config.ts src/ai/agent-config.service.ts src/ai/agent-config.service.spec.ts
git commit -m "feat(ai): AgentConfigService.resolveModelConfig — OpenAI-compatible endpoint config"
```

---

### Task 2: register ai_base_url + ai_api_key settings

**Files:** `src/admin/settings.registry.ts`.

- [ ] **Step 1: Add the two registry entries.** In `KNOWN_SETTINGS`, after the existing `ai_model.intent_classifier` entry (keep alphabetical-ish grouping with the other `ai_*` keys), add:
```ts
  ai_base_url: {
    description: 'OpenAI-compatible inference base URL (blank = provider default)',
    validate: nonEmpty,
  },
  ai_api_key: {
    description: 'Inference API key (used with ai_base_url)',
    validate: nonEmpty,
  },
```
(`nonEmpty` is already defined in the file.)

- [ ] **Step 2: Verify**
Run: `npm run build && npx jest settings`
Expected: build clean; any settings-registry/admin-config tests still pass (the registry change is additive — these keys are now PUT/DELETE-able through `admin/settings`).

- [ ] **Step 3: Commit**
```bash
git add src/admin/settings.registry.ts
git commit -m "feat(admin): allow ai_base_url + ai_api_key settings"
```

---

### Task 3: wire both Agent build sites to resolveModelConfig

**Files:** `src/ai/mastra.service.ts`, `src/interaction/router/intent-classifier.service.ts`.

- [ ] **Step 1: MastraService — triage agent.** In `src/ai/mastra.service.ts`, find:
```ts
    // Resolve model and instructions from AgentConfigService (settings-backed).
    const triage = await this.config.resolve('triage');

    // Create the triage agent with read-only tools.
    const triageAgent = new Agent({
      id: 'triage-agent',
      name: 'Triage Agent',
      instructions: triage.instructions,
      model: triage.model,
      tools,
    });
```
Replace with:
```ts
    // Resolve instructions + the full model config (endpoint-aware) from
    // AgentConfigService (settings-backed).
    const triage = await this.config.resolve('triage');
    const triageModel = await this.config.resolveModelConfig('triage');

    // Create the triage agent with read-only tools.
    const triageAgent = new Agent({
      id: 'triage-agent',
      name: 'Triage Agent',
      instructions: triage.instructions,
      model: triageModel,
      tools,
    });
```

- [ ] **Step 2: IntentClassifierService.** In `src/interaction/router/intent-classifier.service.ts`, find:
```ts
    const { model, instructions } =
      await this.config.resolve('intent_classifier');
    this.agent = new Agent({
      id: 'intent-classifier',
      name: 'Intent Classifier',
      instructions,
      model,
      tools: {},
    });
```
Replace with:
```ts
    const { instructions } = await this.config.resolve('intent_classifier');
    const model = await this.config.resolveModelConfig('intent_classifier');
    this.agent = new Agent({
      id: 'intent-classifier',
      name: 'Intent Classifier',
      instructions,
      model,
      tools: {},
    });
```

- [ ] **Step 3: Build + tests + lint**
Run: `npm run build && npm run lint && npm test`
Expected: build clean (the `Agent` `model` field accepts `ModelConfig` — `string | OpenAICompatibleConfig` — structurally); lint clean; all unit suites pass (the jest mastra-stub `Agent` ignores `model`, so runtime is unaffected; tsc validates the type against real Mastra).

- [ ] **Step 4: Commit**
```bash
git add src/ai/mastra.service.ts src/interaction/router/intent-classifier.service.ts
git commit -m "feat(ai): build agents with endpoint-aware model config"
```

---

### Task 4: Settings page — base URL + API key fields

**Files:** `frontend/src/components/SettingsView.tsx`.

- [ ] **Step 1: Add `secret` to the `LlmKey` interface + password rendering.** In `SettingsView.tsx`, change the `LlmKey` interface to add an optional `secret` flag:
```ts
interface LlmKey {
  key: string;
  label: string;
  placeholder: string;
  multiline: boolean;
  secret?: boolean;
}
```
Then in `SettingRow`, the single-line `<input>` branch (the `else` of `def.multiline`) must use a password type for secret fields. Change that `<input ... />` to include `type`:
```tsx
          <input
            id={id}
            type={def.secret ? 'password' : 'text'}
            placeholder={def.placeholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="flex-1 border rounded px-2 py-1 text-sm font-mono"
          />
```

- [ ] **Step 2: Add the two keys at the TOP of `LLM_KEYS`** (endpoint + key are the foundational config, above the model fields):
```ts
const LLM_KEYS: LlmKey[] = [
  { key: 'ai_base_url', label: 'Inference base URL', placeholder: '(provider default)', multiline: false },
  { key: 'ai_api_key', label: 'API key', placeholder: '(provider default / env)', multiline: false, secret: true },
  { key: 'ai_model', label: 'Global model', placeholder: 'openai/gpt-4o-mini', multiline: false },
  { key: 'ai_model.triage', label: 'Model — triage', placeholder: '(inherits global)', multiline: false },
  { key: 'ai_model.intent_classifier', label: 'Model — intent classifier', placeholder: '(inherits global)', multiline: false },
  { key: 'prompt.triage', label: 'Prompt — triage', placeholder: '(built-in default)', multiline: true },
  { key: 'prompt.intent_classifier', label: 'Prompt — intent classifier', placeholder: '(built-in default)', multiline: true },
];
```

- [ ] **Step 3: Build + tests (CLEAN)**
Run: `cd frontend && rm -f *.tsbuildinfo && npx tsc -b && npm test && npm run build`
Expected: tsc 0; the existing SettingsView tests still pass (the Global model field still resolves via its label — the new fields don't collide: "Inference base URL"/"API key" labels are distinct from "Global model"); build 0.

- [ ] **Step 4: Commit**
```bash
cd /Users/alekseirevin/test/headless-bookkeeping/.claude/worktrees/api-fixes
git add frontend/src/components/SettingsView.tsx
git commit -m "feat(spa): Settings — inference base URL + API key fields"
```

---

### Task 5: final gate + push

- [ ] **Step 1: Backend gate**
Run:
```bash
cd /Users/alekseirevin/test/headless-bookkeeping/.claude/worktrees/api-fixes
npm run build && npm run lint && npm test && npm run test:e2e
```
Expected: build/lint clean; unit suites pass (incl. the new `resolveModelConfig` tests); e2e green (48).

- [ ] **Step 2: Frontend gate — CLEAN**
Run:
```bash
cd /Users/alekseirevin/test/headless-bookkeeping/.claude/worktrees/api-fixes/frontend
rm -f *.tsbuildinfo && npx tsc -b && npm test && npm run build
```
Expected: tsc 0 (clean cache); vitest green; build produces `dist/`.

- [ ] **Step 3: Manual smoke (optional, local)**
On Settings: set **Inference base URL** (e.g. `https://openrouter.ai/api/v1`) + **API key**, Save each; confirm they persist (reload shows them; the key field is masked). With those set, the triage/intent agents build with `{ id, url, apiKey }` (verifiable by a log or by an actual model call if creds are real). Clearing the base URL reverts to gateway/provider-default behavior.

- [ ] **Step 4: Push + hand off**
```bash
git push -u origin operator-spa-inference
```
Then STOP — `main` is protected; open the PR for `operator-spa-inference` manually.

---

## Self-Review

**Spec coverage:**
- Configurable inference base URL + API key → Task 2 (registry) + Task 1 (`resolveModelConfig` builds the OpenAI-compatible object) + Task 3 (both agents use it) + Task 4 (UI fields). ✓
- No regression when unset → `resolveModelConfig` returns the bare string (current behavior); test 1 asserts it. ✓
- API key masked in UI → `secret` → `type="password"`. ✓
- Invalid/unknown key → 400 (registry allowlist) — `ai_base_url`/`ai_api_key` added to the allowlist so they're accepted; anything else still rejected. ✓

**Placeholder scan:** none — full code per step. (Task 1 Step 2 instructs reading the existing spec's seed harness rather than assuming a helper name — that's a deliberate "match the existing pattern" instruction, not a placeholder.)

**Type consistency:** `ModelConfig` (agent-config.ts) ← `resolveModelConfig` ← both Agent build sites; `ModelConfig` is structurally assignable to Mastra's `MastraModelConfig` (`string | OpenAICompatibleConfig`), so `new Agent({ model })` type-checks; the `id as \`${string}/${string}\`` cast satisfies the template-literal field.

**Soft spots:**
- The `ai_api_key` value is retrievable via `GET /admin/settings` (like the existing `telegram_bot_token`) and is prefilled into the password field. Acceptable for the single-tenant tailnet threat model; if hardening is wanted later, the list endpoint could redact `*_key`/`*_token`/`*_secret` values — out of scope here.
- Only the triage + intent_classifier agents exist today; both are wired. A future agent (e.g. the P3 bank-mapping agent) must also use `resolveModelConfig` to honor the endpoint — noted for that plan.
- `resolveModelConfig` issues up to three small settings reads; negligible, and only at agent-construction time (module init), not per request.
