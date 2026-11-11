import type { redactOptions } from 'pino';

/**
 * Request/response fields that carry credentials and must never reach the
 * logs. pino-http's default serializers log every request header, so without
 * this the API bearer token (and the Telegram webhook secret) is written to
 * stdout in plain text on every call.
 */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-telegram-bot-api-secret-token"]',
  'res.headers["set-cookie"]',
];

export const LOG_REDACTION: redactOptions = {
  paths: LOG_REDACT_PATHS,
  censor: '[Redacted]',
};
