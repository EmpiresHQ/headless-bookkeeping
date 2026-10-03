import { useAdminSettings } from '../queries/settings';
import { ScreenHeader } from '../shell/Headers';
import { SkeletonRows } from '../ui/Feedback';
import { GroupLabel } from '../ui/List';
import { LoadError, RefetchError } from '../ui/LoadError';
import {
  IndependentSaveNote,
  SettingField,
  type SettingDef,
} from './SettingField';

const MODEL_INHERIT =
  'Uses the Global model — or the server’s built-in default model when that is not stored either.';

const ENDPOINT_DEFS: SettingDef[] = [
  {
    key: 'ai_base_url',
    label: 'Inference base URL',
    placeholder: '(provider default)',
    hint: 'Any OpenAI-compatible endpoint',
    unset:
      'Models are called at the provider’s default endpoint, and the OCR vision model has no endpoint to call — OCR is off until a base URL is stored.',
  },
  {
    key: 'ai_api_key',
    label: 'API key',
    placeholder: '(provider default / env)',
    secret: true,
    unset: 'No key is sent to a stored base URL.',
  },
];

const MODEL_DEFS: SettingDef[] = [
  {
    key: 'ai_model',
    label: 'Global model',
    placeholder: 'openai/gpt-4o-mini',
    unset:
      'Agents without their own model use the server’s built-in default model.',
  },
  {
    key: 'ai_model.triage_enrichment',
    label: 'Triage — enrichment model',
    placeholder: '(inherits global)',
    unset: MODEL_INHERIT,
  },
  {
    key: 'ai_model.triage_classification',
    label: 'Triage — classification model',
    placeholder: '(inherits global)',
    unset: MODEL_INHERIT,
  },
  {
    key: 'ai_model.intent_classifier',
    label: 'Model — intent classifier',
    placeholder: '(inherits global)',
    unset: MODEL_INHERIT,
  },
  {
    key: 'ai_model.ocr',
    label: 'Model — OCR',
    placeholder: '(inherits global)',
    unset: MODEL_INHERIT,
  },
];

const PROMPT_DEFS: SettingDef[] = [
  {
    key: 'prompt.triage_enrichment',
    label: 'Triage — enrichment prompt',
    placeholder: '(built-in default)',
    unset: 'The built-in prompt for this agent is used.',
    multiline: true,
  },
  {
    key: 'prompt.triage_classification',
    label: 'Triage — classification prompt',
    placeholder: '(built-in default)',
    unset: 'The built-in prompt for this agent is used.',
    multiline: true,
  },
  {
    key: 'prompt.intent_classifier',
    label: 'Prompt — intent classifier',
    placeholder: '(built-in default)',
    unset: 'The built-in prompt for this agent is used.',
    multiline: true,
  },
];

/** /settings/llm — the fixed agent set is triage + intent classifier
 *  (Reality #12); everything is a validated settings key, saved one at a
 *  time. Clear deletes a stored key; what then applies is per key
 *  (agent-config.service: ai_model.<agent> → ai_model → built-in default,
 *  prompt.<agent> → built-in prompt; OCR needs ai_base_url). */
export function LlmScreen() {
  const settingsQ = useAdminSettings();
  if (settingsQ.isPending) {
    return (
      <Frame>
        <SkeletonRows count={4} />
      </Frame>
    );
  }
  if (settingsQ.isError && settingsQ.data === undefined) {
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
  const group = (defs: SettingDef[]) => (
    <div className="mx-3.5 mb-3.5 space-y-4 rounded-2xl bg-surface p-4">
      {defs.map((def) => (
        <SettingField key={def.key} def={def} />
      ))}
    </div>
  );
  return (
    <Frame>
      <RefetchError query={settingsQ} />
      <p className="mx-6 mb-3 text-[12.5px] text-ink-2">
        Model ids must include a provider prefix, e.g.{' '}
        <code className="font-mono">openai/gpt-4o-mini</code>. For a custom
        OpenAI-compatible endpoint, set the base URL/key and keep the{' '}
        <code className="font-mono">openai/</code> prefix — it only selects the
        request format; requests still go to your base URL.
      </p>
      <IndependentSaveNote />
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
