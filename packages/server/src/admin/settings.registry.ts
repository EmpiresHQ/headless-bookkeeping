/** The settings an operator may set over HTTP. Each entry validates its value.
 * Agent keys are enumerated explicitly (the agent set is fixed: triage, intent_classifier). */
export interface KnownSetting {
  description: string;
  validate(value: string): boolean;
}

const nonEmpty = (v: string): boolean => v.trim().length > 0;
const ingestPolicy = (v: string): boolean =>
  v === 'known-only' || v === 'quarantine' || v === 'open';
const httpsOrLocalhost = (v: string): boolean =>
  /^https:\/\//.test(v) ||
  /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(v);

export const KNOWN_SETTINGS: Record<string, KnownSetting> = {
  ai_model: {
    description:
      'Global default AI model id. Must include a provider prefix, e.g. ' +
      'openai/gpt-4o-mini or openai/<model> for a custom OpenAI-compatible ' +
      'endpoint (the prefix selects the request adapter; the base URL comes ' +
      'from ai_base_url).',
    validate: nonEmpty,
  },
  'ai_model.triage': {
    description:
      'Model override for the triage agent (provider/model, e.g. openai/<model>)',
    validate: nonEmpty,
  },
  'ai_model.intent_classifier': {
    description:
      'Model override for the intent classifier (provider/model, e.g. openai/<model>)',
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
  public_api_url: {
    description:
      'Public base URL the mobile app talks to, embedded in the enrollment ' +
      'QR. Must be https:// (http://localhost is allowed for dev).',
    validate: httpsOrLocalhost,
  },
  google_oauth_client_id: {
    description: 'BYO Google OAuth client id for Gmail mailbox connectors',
    validate: nonEmpty,
  },
  google_oauth_client_secret: {
    description: 'BYO Google OAuth client secret',
    validate: nonEmpty,
  },
  microsoft_oauth_client_id: {
    description: 'BYO Microsoft OAuth client id for Outlook mailbox connectors',
    validate: nonEmpty,
  },
  microsoft_oauth_client_secret: {
    description: 'BYO Microsoft OAuth client secret',
    validate: nonEmpty,
  },
};

export function isKnownSettingKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(KNOWN_SETTINGS, key);
}
