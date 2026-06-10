# Operator SPA — Settings page (LLM + policy) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Verification note:** the frontend `tsc -b` is incremental — before any "type-check is green" claim, delete `frontend/*.tsbuildinfo` so the check matches a clean CI build.

**Goal:** A Settings tab on the operator SPA to configure the LLM agents (global + per-agent model and prompt overrides) and the risk-gate policy (auto-post thresholds + ingest policy), over the existing guarded API.

**Architecture:** A new Custom tab "Settings" (same mechanism as KMD/Intake/Approvals). LLM + ingest config go through the validated `admin/settings` key/value API; the risk gate goes through the structured `GET|PUT /api/policy-config`. OCR is **out of scope** — it is a faux model in v1 with no configurable provider/model; the page states this rather than offering a dead knob.

**Tech Stack:** React 18 + TS + Tailwind + Vitest/@testing-library (existing `frontend/`).

---

## Endpoint contract (already on `main`)

| Surface | Request | Response |
|---|---|---|
| List settings | `GET /admin/settings` | `{ settings: { key, value }[] }` |
| Set a setting | `PUT /admin/settings/:key` — JSON `{ value }` | `{ key, value }` (200) — 400 if key/value invalid |
| Clear a setting | `DELETE /admin/settings/:key` | `{ key, deleted: true }` (200) |
| Policy config | `GET /api/policy-config` | `PolicyConfig` |
| Update policy | `PUT /api/policy-config` — JSON partial | `PolicyConfig` |

**Settable keys** (validated server-side by the `KNOWN_SETTINGS` registry; an unknown key or bad value → 400, surfaced via `apiFetch`'s error message):
- `ai_model` — global default model (server fallback `openai/gpt-4o-mini`)
- `ai_model.triage`, `ai_model.intent_classifier` — per-agent model override (else inherit global)
- `prompt.triage`, `prompt.intent_classifier` — per-agent instruction override (else built-in default)
- `ingest_policy` — `known-only | quarantine | open`

`PolicyConfig` = `{ auto_post_amount_ceiling: number /* cents */, auto_post_min_confidence: number /* 0–1 */, unknown_supplier_requires_approval: boolean, always_approve_operations: string[] }`. The update body is a partial of these four.

> The two agents with configurable model+prompt are exactly `triage` and `intent_classifier` (`AgentConfigService`). OCR is not an agent in v1.

## File Structure
- Modify `frontend/src/api.ts` — `Setting` + `PolicyConfig` types; `getSettings`, `setSetting`, `deleteSetting`, `getPolicyConfig`, `updatePolicyConfig`.
- Modify `frontend/src/api.test.ts` — `setSetting` PUT path/body; `getPolicyConfig` path; `updatePolicyConfig` PUT body.
- Create `frontend/src/components/SettingsView.tsx` + `SettingsView.test.tsx`.
- Modify `frontend/src/tabs.tsx` — add `settingsTab` (Custom).

---

### Task 1: api.ts — settings + policy-config helpers (TDD)

**Files:** Modify `frontend/src/api.ts`; Modify `frontend/src/api.test.ts`.

- [ ] **Step 1: Write failing tests** — append these `it` blocks inside the existing top-level `describe` in `frontend/src/api.test.ts`, before its closing `});`:
```ts
  it('setSetting PUTs the value as JSON to the key path', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('{"key":"ai_model","value":"openai/gpt-4o"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const { setSetting } = await import('./api');
    await setSetting('ai_model', 'openai/gpt-4o');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/admin/settings/ai_model');
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(init?.body as string)).toEqual({ value: 'openai/gpt-4o' });
  });

  it('getPolicyConfig GETs /api/policy-config', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"auto_post_amount_ceiling":50000}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const { getPolicyConfig } = await import('./api');
    const cfg = await getPolicyConfig();
    expect(cfg.auto_post_amount_ceiling).toBe(50000);
  });

  it('updatePolicyConfig PUTs a partial patch as JSON', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('{"auto_post_amount_ceiling":10000}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const { updatePolicyConfig } = await import('./api');
    await updatePolicyConfig({ auto_post_amount_ceiling: 10000 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/policy-config');
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(init?.body as string)).toEqual({
      auto_post_amount_ceiling: 10000,
    });
  });
```

- [ ] **Step 2: Run — expect FAIL**
Run: `cd frontend && npx vitest run src/api.test.ts`

- [ ] **Step 3: Append to `frontend/src/api.ts`** (after the approvals block):
```ts

// ── Settings (admin/settings key/value) ───────────────────────────────────
export interface Setting {
  key: string;
  value: string;
}

export const getSettings = () =>
  apiFetch<{ settings: Setting[] }>('/admin/settings').then((r) => r.settings);

export const setSetting = (key: string, value: string) =>
  apiFetch<{ key: string; value: string }>(
    `/admin/settings/${encodeURIComponent(key)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value }),
    },
  );

export const deleteSetting = (key: string) =>
  apiFetch<{ key: string; deleted: true }>(
    `/admin/settings/${encodeURIComponent(key)}`,
    { method: 'DELETE' },
  );

// ── Policy / risk gate (GET|PUT /api/policy-config) ───────────────────────
export interface PolicyConfig {
  auto_post_amount_ceiling: number;
  auto_post_min_confidence: number;
  unknown_supplier_requires_approval: boolean;
  always_approve_operations: string[];
}

export const getPolicyConfig = () =>
  apiFetch<PolicyConfig>('/api/policy-config');

export const updatePolicyConfig = (patch: Partial<PolicyConfig>) =>
  apiFetch<PolicyConfig>('/api/policy-config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
```

- [ ] **Step 4: Run — expect PASS**
Run: `cd frontend && npx vitest run src/api.test.ts` → expect 8 passing (5 existing + 3). `cd frontend && rm -f *.tsbuildinfo && npx tsc -b` → exit 0.

- [ ] **Step 5: Commit**
```bash
cd /Users/alekseirevin/test/headless-bookkeeping/.claude/worktrees/api-fixes
git add frontend/src/api.ts frontend/src/api.test.ts
git commit -m "feat(spa): settings + policy-config api helpers"
```

---

### Task 2: SettingsView component (LLM + policy)

**Files:** Create `frontend/src/components/SettingsView.tsx` + `SettingsView.test.tsx`.

- [ ] **Step 1: Write the failing test** — create `frontend/src/components/SettingsView.test.tsx`:
```tsx
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SettingsView } from './SettingsView';
import * as api from '../api';

describe('SettingsView', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getSettings').mockResolvedValue([
      { key: 'ai_model', value: 'openai/gpt-4o' },
    ]);
    vi.spyOn(api, 'getPolicyConfig').mockResolvedValue({
      auto_post_amount_ceiling: 50000,
      auto_post_min_confidence: 0.9,
      unknown_supplier_requires_approval: true,
      always_approve_operations: [],
    });
    vi.spyOn(api, 'setSetting').mockResolvedValue({
      key: 'ai_model',
      value: 'x',
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows the current global model and saves an edit', async () => {
    render(<SettingsView />);

    const input = (await screen.findByLabelText(
      /global model/i,
    )) as HTMLInputElement;
    expect(input.value).toBe('openai/gpt-4o');

    fireEvent.change(input, { target: { value: 'anthropic/claude-3-5' } });
    fireEvent.click(
      screen.getByRole('button', { name: /save global model/i }),
    );

    await waitFor(() =>
      expect(api.setSetting).toHaveBeenCalledWith(
        'ai_model',
        'anthropic/claude-3-5',
      ),
    );
  });

  it('shows the policy ceiling from policy-config', async () => {
    render(<SettingsView />);
    const ceiling = (await screen.findByLabelText(
      /amount ceiling/i,
    )) as HTMLInputElement;
    expect(ceiling.value).toBe('50000');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**
Run: `cd frontend && npx vitest run src/components/SettingsView.test.tsx`

- [ ] **Step 3: Create `frontend/src/components/SettingsView.tsx`:**
```tsx
import { useEffect, useState } from 'react';
import {
  getSettings,
  setSetting,
  deleteSetting,
  getPolicyConfig,
  updatePolicyConfig,
  type PolicyConfig,
} from '../api';

interface LlmKey {
  key: string;
  label: string;
  placeholder: string;
  multiline: boolean;
}

const LLM_KEYS: LlmKey[] = [
  { key: 'ai_model', label: 'Global model', placeholder: 'openai/gpt-4o-mini', multiline: false },
  { key: 'ai_model.triage', label: 'Model — triage', placeholder: '(inherits global)', multiline: false },
  { key: 'ai_model.intent_classifier', label: 'Model — intent classifier', placeholder: '(inherits global)', multiline: false },
  { key: 'prompt.triage', label: 'Prompt — triage', placeholder: '(built-in default)', multiline: true },
  { key: 'prompt.intent_classifier', label: 'Prompt — intent classifier', placeholder: '(built-in default)', multiline: true },
];

const INGEST_OPTIONS = ['known-only', 'quarantine', 'open'] as const;

/** One admin/settings key: edit + save (PUT) / clear-to-default (DELETE). */
function SettingRow({
  def,
  current,
  onChanged,
  onError,
}: {
  def: LlmKey;
  current: string;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const [draft, setDraft] = useState(current);
  const [busy, setBusy] = useState(false);

  // Re-sync the draft when the underlying value reloads.
  useEffect(() => setDraft(current), [current]);

  const guard = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const id = `setting-${def.key}`;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium text-gray-700">
        {def.label}
      </label>
      <div className="flex items-start gap-2">
        {def.multiline ? (
          <textarea
            id={id}
            rows={3}
            placeholder={def.placeholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="flex-1 border rounded px-2 py-1 text-sm font-mono"
          />
        ) : (
          <input
            id={id}
            placeholder={def.placeholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="flex-1 border rounded px-2 py-1 text-sm font-mono"
          />
        )}
        <button
          type="button"
          disabled={busy || draft.trim().length === 0}
          aria-label={`Save ${def.label}`}
          onClick={() => void guard(() => setSetting(def.key, draft.trim()))}
          className="bg-black text-white rounded px-3 py-1 text-sm disabled:opacity-50"
        >
          Save
        </button>
        <button
          type="button"
          disabled={busy || current.length === 0}
          aria-label={`Clear ${def.label}`}
          onClick={() => void guard(() => deleteSetting(def.key))}
          className="text-gray-600 text-sm hover:underline disabled:opacity-40"
        >
          Clear
        </button>
      </div>
    </div>
  );
}

export function SettingsView() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [policy, setPolicy] = useState<PolicyConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const loadSettings = () =>
    getSettings()
      .then((list) =>
        setSettings(Object.fromEntries(list.map((s) => [s.key, s.value]))),
      )
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  const loadPolicy = () =>
    getPolicyConfig()
      .then(setPolicy)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => {
    void loadSettings();
    void loadPolicy();
  }, []);

  const onIngestChange = async (value: string) => {
    setError(null);
    try {
      await setSetting('ingest_policy', value);
      await loadSettings();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const savePolicy = async () => {
    if (!policy) return;
    setError(null);
    setSavedNote(null);
    try {
      const saved = await updatePolicyConfig(policy);
      setPolicy(saved);
      setSavedNote('Policy saved.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="p-4 space-y-8 max-w-3xl">
      {error && <p className="text-sm text-red-600">{error}</p>}

      <section className="space-y-4">
        <h2 className="font-semibold">LLM agents</h2>
        <p className="text-xs text-gray-500">
          Blank = use the built-in default. Per-agent model overrides the global
          model; the agents are triage and the intent classifier.
        </p>
        {LLM_KEYS.map((def) => (
          <SettingRow
            key={def.key}
            def={def}
            current={settings[def.key] ?? ''}
            onChanged={loadSettings}
            onError={setError}
          />
        ))}
        <p className="text-xs text-gray-400">
          OCR uses a faux model in v1 — there is no OCR provider/model to
          configure yet.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">Intake policy</h2>
        <label className="text-sm flex items-center gap-2">
          <span className="text-gray-700">Ingest policy</span>
          <select
            aria-label="Ingest policy"
            value={settings['ingest_policy'] ?? ''}
            onChange={(e) => void onIngestChange(e.target.value)}
            className="border rounded px-2 py-1 text-sm"
          >
            <option value="" disabled>
              (choose)
            </option>
            {INGEST_OPTIONS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">Risk gate</h2>
        {policy && (
          <div className="space-y-3 text-sm">
            <label className="flex items-center gap-2">
              <span className="w-56 text-gray-700">
                Auto-post amount ceiling (cents)
              </span>
              <input
                aria-label="Amount ceiling"
                type="number"
                value={policy.auto_post_amount_ceiling}
                onChange={(e) =>
                  setPolicy({
                    ...policy,
                    auto_post_amount_ceiling: Number(e.target.value),
                  })
                }
                className="border rounded px-2 py-1 w-40 tabular-nums"
              />
            </label>
            <label className="flex items-center gap-2">
              <span className="w-56 text-gray-700">
                Min confidence (0–1)
              </span>
              <input
                aria-label="Min confidence"
                type="number"
                step="0.01"
                value={policy.auto_post_min_confidence}
                onChange={(e) =>
                  setPolicy({
                    ...policy,
                    auto_post_min_confidence: Number(e.target.value),
                  })
                }
                className="border rounded px-2 py-1 w-40 tabular-nums"
              />
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={policy.unknown_supplier_requires_approval}
                onChange={(e) =>
                  setPolicy({
                    ...policy,
                    unknown_supplier_requires_approval: e.target.checked,
                  })
                }
              />
              <span className="text-gray-700">
                Unknown supplier requires approval
              </span>
            </label>
            <label className="flex items-center gap-2">
              <span className="w-56 text-gray-700">
                Always-approve operations
              </span>
              <input
                aria-label="Always-approve operations"
                value={policy.always_approve_operations.join(', ')}
                onChange={(e) =>
                  setPolicy({
                    ...policy,
                    always_approve_operations: e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter((s) => s.length > 0),
                  })
                }
                placeholder="comma-separated"
                className="border rounded px-2 py-1 flex-1"
              />
            </label>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void savePolicy()}
                className="bg-black text-white rounded px-3 py-1"
              >
                Save policy
              </button>
              {savedNote && (
                <span className="text-green-700">{savedNote}</span>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Run — expect PASS**
Run: `cd frontend && npx vitest run src/components/SettingsView.test.tsx` → 2 pass. `cd frontend && rm -f *.tsbuildinfo && npx tsc -b` → exit 0.

- [ ] **Step 5: Commit**
```bash
cd /Users/alekseirevin/test/headless-bookkeeping/.claude/worktrees/api-fixes
git add frontend/src/components/SettingsView.tsx frontend/src/components/SettingsView.test.tsx
git commit -m "feat(spa): SettingsView — LLM agents + intake/risk-gate policy"
```

---

### Task 3: add the Settings tab

**Files:** Modify `frontend/src/tabs.tsx`.

- [ ] **Step 1: Import** — after the existing `import { ApprovalsView } from './components/ApprovalsView';` line, add:
```tsx
import { SettingsView } from './components/SettingsView';
```

- [ ] **Step 2: Define the tab** — after the existing `approvalsTab` constant, add:
```tsx
const settingsTab: TabDef = {
  key: 'settings',
  label: 'Settings',
  load: async () => [],
  columns: [],
  Custom: SettingsView,
};
```

- [ ] **Step 3: Append to `TABS`** — add `settingsTab` as the LAST element of the `TABS` array (after `kmdTab`). First read the current array to confirm its members, then append `settingsTab` as the final entry.

- [ ] **Step 4: Build + tests**
Run: `cd frontend && rm -f *.tsbuildinfo && npx tsc -b && npm test && npm run build`
Expected: tsc 0; all vitest suites green; build 0.

- [ ] **Step 5: Commit**
```bash
cd /Users/alekseirevin/test/headless-bookkeeping/.claude/worktrees/api-fixes
git add frontend/src/tabs.tsx
git commit -m "feat(spa): add Settings tab"
```

---

### Task 4: final gate + push

- [ ] **Step 1: Backend gate**
Run:
```bash
cd /Users/alekseirevin/test/headless-bookkeeping/.claude/worktrees/api-fixes
npm run build && npm run lint && npm run test:e2e
```
Expected: build clean; lint clean; e2e green (48).

- [ ] **Step 2: Frontend gate — CLEAN (matches CI)**
Run:
```bash
cd /Users/alekseirevin/test/headless-bookkeeping/.claude/worktrees/api-fixes/frontend
rm -f *.tsbuildinfo && npx tsc -b && npm test && npm run build
```
Expected: tsc 0 (from a clean cache); vitest green (auth, api, Table, KmdView, IntakeView, ApprovalsView, SettingsView); build produces `dist/`.

- [ ] **Step 3: Manual smoke (optional, local)**
`npm run start:dev` + `cd frontend && npm run dev`; on **Settings**: the LLM fields show current values (blank = default); editing the global model + Save persists (reload shows it); Clear removes the override; the ingest-policy select and the risk-gate form load from the server and save. Confirm the OCR note is shown and there is no OCR control.

- [ ] **Step 4: Push and hand off**
```bash
git push -u origin operator-spa-settings
```
Then STOP — `main` is protected; open the PR for `operator-spa-settings` manually.

---

## Self-Review

**Spec coverage:**
- LLM global + per-agent model + per-agent prompt config → Task 1 (`getSettings`/`setSetting`/`deleteSetting`) + Task 2 `LLM_KEYS` rows. ✓
- Ingest policy select → Task 2 ingest section. ✓
- Risk-gate policy (ceiling, confidence, unknown→approval, always-approve ops) → Task 1 `getPolicyConfig`/`updatePolicyConfig` + Task 2 risk-gate form. ✓
- OCR skipped with an explicit note, no control → Task 2. ✓
- Tab wired → Task 3. ✓
- Invalid value / unknown key → 400 surfaced via `apiFetch` error message → shown in the `error` line. ✓

**Placeholder scan:** none — full code in every step (Task 3 Step 3 asks the implementer to read the current `TABS` before appending, which is correct since other branches may have changed it — but the append target `settingsTab` is fully specified).

**Type consistency:** `Setting`/`PolicyConfig` (api.ts) ← SettingsView; `setSetting(key, value)` signature matches the SettingRow save call and the test assertion; `updatePolicyConfig(Partial<PolicyConfig>)` matches the backend partial PUT; `LLM_KEYS` keys are exactly the registry's settable LLM keys.

**Soft spots:**
- Like the other custom-tab views, SettingsView surfaces a 401 as an error string rather than redirecting to the gate (consistent; the shared `onUnauthorized` fix is still the future cleanup).
- `auto_post_min_confidence` is a v1 stub server-side (always 1.0 in decisions) — the field is still editable/persisted; that's faithful to the API.
- The `ai_model.*`/`prompt.*` keys contain a dot; they're sent path-encoded via `encodeURIComponent` (dots are unreserved, so the literal key reaches the backend `@Param('key')`).
