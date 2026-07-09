import { useAdminSettings } from '../queries/settings';
import { ScreenHeader } from '../shell/Headers';
import { SkeletonRows } from '../ui/Feedback';
import { GroupLabel } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { SettingField, type SettingDef } from './SettingField';

const ENDPOINT_DEFS: SettingDef[] = [
  {
    key: 'ai_base_url',
    label: 'Inference base URL',
    placeholder: '(provider default)',
    hint: 'Any OpenAI-compatible endpoint',
  },
  {
    key: 'ai_api_key',
    label: 'API key',
    placeholder: '(provider default / env)',
    secret: true,
  },
];

const MODEL_DEFS: SettingDef[] = [
  { key: 'ai_model', label: 'Global model', placeholder: 'openai/gpt-4o-mini' },
  {
    key: 'ai_model.triage',
    label: 'Model — triage',
    placeholder: '(inherits global)',
  },
  {
    key: 'ai_model.intent_classifier',
    label: 'Model — intent classifier',
    placeholder: '(inherits global)',
  },
  {
    key: 'ai_model.ocr',
    label: 'Model — OCR',
    placeholder: '(inherits global)',
  },
];

const PROMPT_DEFS: SettingDef[] = [
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

/** /settings/llm — the fixed agent set is triage + intent classifier
 *  (Reality #12); everything is a validated settings key. Blank = built-in
 *  default; Clear returns a key to that default. */
export function LlmScreen() {
  const settingsQ = useAdminSettings();
  if (settingsQ.isPending) {
    return (
      <Frame>
        <SkeletonRows count={4} />
      </Frame>
    );
  }
  if (settingsQ.isError) {
    return (
      <Frame>
        <LoadError
          message={
            settingsQ.error instanceof Error
              ? settingsQ.error.message
              : 'Failed to load settings'
          }
          onRetry={() => void settingsQ.refetch()}
        />
      </Frame>
    );
  }
  const map = settingsQ.data;
  const group = (defs: SettingDef[]) => (
    <div className="mx-3.5 mb-3.5 space-y-4 rounded-2xl bg-surface p-4">
      {defs.map((def) => (
        <SettingField key={def.key} def={def} current={map[def.key] ?? ''} />
      ))}
    </div>
  );
  return (
    <Frame>
      <p className="mx-6 mb-3 text-[12.5px] text-ink-2">
        Model ids must include a provider prefix, e.g.{' '}
        <code className="font-mono">openai/gpt-4o-mini</code>. For a custom
        OpenAI-compatible endpoint, set the base URL/key and keep the{' '}
        <code className="font-mono">openai/</code> prefix — it only selects the
        request format; requests still go to your base URL.
      </p>
      <GroupLabel>Endpoint</GroupLabel>
      {group(ENDPOINT_DEFS)}
      <GroupLabel>Models</GroupLabel>
      {group(MODEL_DEFS)}
      <GroupLabel>Prompts</GroupLabel>
      {group(PROMPT_DEFS)}
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title="AI models" backTo="/settings" />
      {children}
    </div>
  );
}
