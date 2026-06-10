/** The settings an operator may set over HTTP. Each entry validates its value.
 * Agent keys are enumerated explicitly (the agent set is fixed: triage, intent_classifier). */
export interface KnownSetting {
  description: string;
  validate(value: string): boolean;
}

const nonEmpty = (v: string): boolean => v.trim().length > 0;
const ingestPolicy = (v: string): boolean =>
  v === 'known-only' || v === 'quarantine' || v === 'open';

export const KNOWN_SETTINGS: Record<string, KnownSetting> = {
  ai_model: { description: 'Global default AI model id', validate: nonEmpty },
  'ai_model.triage': {
    description: 'Model override for the triage agent',
    validate: nonEmpty,
  },
  'ai_model.intent_classifier': {
    description: 'Model override for the intent classifier',
    validate: nonEmpty,
  },
  'ai_model.ocr': {
    description:
      'Model id for the OCR vision endpoint (e.g. a dots.ocr model on LiteLLM)',
    validate: nonEmpty,
  },
  ai_base_url: {
    description:
      'OpenAI-compatible inference base URL (blank = provider default)',
    validate: nonEmpty,
  },
  ai_api_key: {
    description: 'Inference API key (used with ai_base_url)',
    validate: nonEmpty,
  },
  'prompt.triage': {
    description: 'Instruction override for the triage agent',
    validate: nonEmpty,
  },
  'prompt.intent_classifier': {
    description: 'Instruction override for the intent classifier',
    validate: nonEmpty,
  },
  ingest_policy: {
    description: 'known-only | quarantine | open',
    validate: ingestPolicy,
  },
  telegram_allowlist: {
    description: 'Comma-separated Telegram chat ids',
    validate: nonEmpty,
  },
  telegram_webhook_secret: {
    description: 'Telegram webhook secret token',
    validate: nonEmpty,
  },
  telegram_bot_token: { description: 'Telegram bot token', validate: nonEmpty },
  approvers: {
    description: 'Comma-separated approver identities',
    validate: nonEmpty,
  },
  email_whitelist: {
    description: 'Comma-separated converse/command allowlist',
    validate: nonEmpty,
  },
};

export function isKnownSettingKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(KNOWN_SETTINGS, key);
}
