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
  secret?: boolean;
}

const LLM_KEYS: LlmKey[] = [
  {
    key: 'ai_base_url',
    label: 'Inference base URL',
    placeholder: '(provider default)',
    multiline: false,
  },
  {
    key: 'ai_api_key',
    label: 'API key',
    placeholder: '(provider default / env)',
    multiline: false,
    secret: true,
  },
  {
    key: 'ai_model',
    label: 'Global model',
    placeholder: 'openai/gpt-4o-mini',
    multiline: false,
  },
  {
    key: 'ai_model.triage',
    label: 'Model — triage',
    placeholder: '(inherits global)',
    multiline: false,
  },
  {
    key: 'ai_model.intent_classifier',
    label: 'Model — intent classifier',
    placeholder: '(inherits global)',
    multiline: false,
  },
  {
    key: 'ai_model.ocr',
    label: 'Model — OCR',
    placeholder: '(inherits global)',
    multiline: false,
  },
  {
    key: 'prompt.triage',
    label: 'Prompt — triage',
    placeholder: '(built-in default)',
    multiline: true,
  },
  {
    key: 'prompt.intent_classifier',
    label: 'Prompt — intent classifier',
    placeholder: '(built-in default)',
    multiline: true,
  },
];

const INGEST_OPTIONS = ['known-only', 'quarantine', 'open'] as const;

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
      <div className="flex flex-wrap items-start gap-2">
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
            type={def.secret ? 'password' : 'text'}
            placeholder={def.placeholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="flex-1 border rounded px-2 py-1 text-sm font-mono"
          />
        )}
        <button
          type="button"
          disabled={busy || draft.trim().length === 0}
          onClick={() => void guard(() => setSetting(def.key, draft.trim()))}
          className="bg-black text-white rounded px-3 py-1 text-sm disabled:opacity-50"
        >
          <span className="sr-only">Save {def.label}</span>
          <span aria-hidden="true">Save</span>
        </button>
        <button
          type="button"
          disabled={busy || current.length === 0}
          onClick={() => void guard(() => deleteSetting(def.key))}
          className="text-gray-600 text-sm hover:underline disabled:opacity-40"
        >
          <span className="sr-only">Clear {def.label}</span>
          <span aria-hidden="true">Clear</span>
        </button>
      </div>
    </div>
  );
}

export function SettingsView() {
  const [settings, setSettings] = useState<Record<string, string> | null>(null);
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
        <p className="text-xs text-amber-700">
          Model ids must include a provider prefix, e.g.{' '}
          <code className="font-mono">openai/gpt-4o-mini</code>. For a custom
          OpenAI-compatible endpoint, set the base URL/key below and prefix the
          model with <code className="font-mono">openai/</code> (e.g.{' '}
          <code className="font-mono">openai/qwen3.6-coder-fast</code>) — the
          prefix only selects the request format; requests still go to your base
          URL.
        </p>
        {settings !== null &&
          LLM_KEYS.map((def) => (
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

      <section className="space-y-4">
        <h2 className="font-semibold">Mobile enrollment</h2>
        <p className="text-xs text-gray-500">
          Public base URL the mobile app talks to. It is embedded in the device
          enrollment QR code. Must be https:// (http://localhost for dev).
        </p>
        {settings !== null && (
          <SettingRow
            def={{
              key: 'public_api_url',
              label: 'Public API URL',
              placeholder: 'https://api.example.com',
              multiline: false,
            }}
            current={settings['public_api_url'] ?? ''}
            onChanged={loadSettings}
            onError={setError}
          />
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">Intake policy</h2>
        <label className="text-sm flex items-center gap-2">
          <span className="text-gray-700">Ingest policy</span>
          <select
            aria-label="Ingest policy"
            value={settings?.['ingest_policy'] ?? ''}
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
            <label className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2">
              <span className="sm:w-56 text-gray-700">
                Auto-post amount ceiling (cents)
              </span>
              <input
                aria-label="Amount ceiling"
                type="number"
                min={0}
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
            <label className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2">
              <span className="sm:w-56 text-gray-700">
                Min confidence (0–1)
              </span>
              <input
                aria-label="Min confidence"
                type="number"
                step="0.01"
                min={0}
                max={1}
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
            <label className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2">
              <span className="sm:w-56 text-gray-700">
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
              {savedNote && <span className="text-green-700">{savedNote}</span>}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
