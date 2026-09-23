export const TOKEN_KEY = 'bk_api_token';

/**
 * Session revision (issue #251). Bumped by every sign-in (setToken) and
 * sign-out/401 (clearToken). A request belongs to the revision it STARTED
 * under: if the revision moved while it was in flight — after the fetch, and
 * after every body read — its outcome belongs to an ended session and is
 * delivered as SessionChangedError instead (never data, never a 401 that
 * clears the NEXT session's token). So an old multi-stage chain stops at its
 * next boundary instead of sending a later stage with a newer token. What
 * the server already accepted stays accepted; the client only stops
 * acting on it.
 */
let revision = 0;

/** Which session a request or operation belongs to: this tab's revision
 *  AND the token itself — another tab can replace the stored token without
 *  this module's revision moving. */
export interface SessionStamp {
  readonly revision: number;
  readonly token: string | null;
}

export function sessionStamp(): SessionStamp {
  return { revision, token: getToken() };
}

export function isSameSession(stamp: SessionStamp): boolean {
  return stamp.revision === revision && stamp.token === getToken();
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

/**
 * A random, non-secret id of the stored sign-in (issue #254), shared by all
 * tabs through localStorage: every setToken mints a new one, clearToken
 * removes it. Client state that must not outlive its session (the bank-
 * import resume pointer) records it instead of anything token-derived.
 */
export const SESSION_ID_KEY = 'bk_session_id';

function newSessionId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** The current sign-in's id, or null when signed out. A token stored
 *  before ids existed gets one lazily. */
export function currentSessionId(): string | null {
  if (getToken() === null) return null;
  let id = localStorage.getItem(SESSION_ID_KEY);
  if (id === null) {
    id = newSessionId();
    localStorage.setItem(SESSION_ID_KEY, id);
  }
  return id;
}

export function setToken(token: string): void {
  revision += 1;
  localStorage.setItem(SESSION_ID_KEY, newSessionId());
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  revision += 1;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(SESSION_ID_KEY);
}

/** Raised on a 401 of the CURRENT session so the UI can drop back to the
 *  token gate. `endedRevision` is the revision this 401 ended (the one its
 *  own clearToken produced): the shell signs out only while that is still
 *  the live revision — a newer sign-in makes it history. */
export class UnauthorizedError extends Error {
  constructor(readonly endedRevision: number) {
    super('Unauthorized — token cleared');
    this.name = 'UnauthorizedError';
  }
}

/** The request's session ended while it was in flight (sign-out, a 401
 *  elsewhere, a new sign-in). Its outcome must not be acted on. */
export class SessionChangedError extends Error {
  constructor() {
    super('The session changed while the request was in flight');
    this.name = 'SessionChangedError';
  }
}

/** The server's request-validation answer (issue #265): the Zod pipe's flat
 *  `{ field: [messages], _errors?: [messages] }`, kept as sent. */
export interface ValidationDetail {
  readonly fields: Readonly<Record<string, readonly string[]>>;
  /** `_errors` — payload-level messages that belong to no field. */
  readonly formErrors: readonly string[];
}

/** A non-OK, non-401 response of the current session. The message keeps
 *  the "<status> <text>: <detail>" shape callers already render;
 *  `validation` is set only for the Zod pipe's structured 400 — a free-text
 *  message never names a field. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly validation: ValidationDetail | null = null,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** True for a 401 that ended the session that is still current — the only
 *  kind that may sign the shell out (no sign-in since, here or in another
 *  tab). */
export function isCurrentUnauthorized(e: unknown): e is UnauthorizedError {
  return (
    e instanceof UnauthorizedError &&
    e.endedRevision === revision &&
    getToken() === null
  );
}

/** The ownership check run after every await of a request. */
function owned(startedAt: SessionStamp): void {
  if (!isSameSession(startedAt)) throw new SessionChangedError();
}

/** Send with the stored Bearer token; resolve only with an OK response that
 *  still belongs to the session the request started under. */
async function send(path: string, init: RequestInit): Promise<Response> {
  const startedAt = sessionStamp();
  const headers = new Headers(init.headers);
  const token = startedAt.token;
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch (e) {
    owned(startedAt);
    throw e;
  }
  owned(startedAt);

  if (res.status === 401) {
    clearToken();
    throw new UnauthorizedError(revision);
  }
  if (!res.ok) {
    const { detail, validation } = await errorDetail(res).catch(
      (e: unknown) => {
        owned(startedAt);
        throw e;
      },
    );
    owned(startedAt);
    throw new HttpError(
      res.status,
      `${res.status} ${res.statusText}: ${detail}`,
      validation,
    );
  }
  return res;
}

/**
 * fetch wrapper that attaches the stored Bearer token, surfaces a 401 by
 * clearing the token and throwing UnauthorizedError, and returns parsed JSON.
 * Session-owned: see `revision` above.
 */
export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const startedAt = sessionStamp();
  const res = await send(path, init);
  // P1 only calls JSON GET endpoints, so we always parse. When P2 adds
  // mutations that may return 204 No Content, this must grow an empty-body
  // guard (and a test) before such a call is made.
  let body: T;
  try {
    body = (await res.json()) as T;
  } catch (e) {
    owned(startedAt);
    throw e;
  }
  owned(startedAt);
  return body;
}

/**
 * Like apiFetch but returns the raw Response instead of parsed JSON.
 * Used for binary/blob downloads (e.g. statutory-report XML/ZIP).
 */
export async function apiFetchRaw(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  // Session-owned up to the headers; the caller's own body read (a blob
  // download) is not an operation continuation.
  return send(path, init);
}

/**
 * Extract a human-readable detail from an error response. NestJS errors return
 * `{ statusCode, message, error }` where `message` is a string (or string[] for
 * validation errors); prefer that over the raw JSON blob. Falls back to the raw
 * body when it is not the expected JSON shape. The Zod pipe's structured 400
 * is also returned as `validation` — only when EVERY key is a string array,
 * so a Nest error or any other body is never read as field errors.
 */
async function errorDetail(
  res: Response,
): Promise<{ detail: string; validation: ValidationDetail | null }> {
  const body = await res.text();
  try {
    const parsed = JSON.parse(body) as Record<string, unknown> & {
      message?: string | string[];
    };
    if (parsed.message) {
      return {
        detail: Array.isArray(parsed.message)
          ? parsed.message.join('; ')
          : parsed.message,
        validation: null,
      };
    }
    // The server's Zod pipe answers 400 with `{ field: [messages] }` (plus
    // `_errors` for payload-level ones) — render it as "field: message".
    const entries = Object.entries(parsed);
    const isMessages = (v: unknown): v is string[] =>
      Array.isArray(v) && v.every((m) => typeof m === 'string');
    const fieldErrors = entries.filter((e): e is [string, string[]] =>
      isMessages(e[1]),
    );
    if (fieldErrors.length > 0) {
      const structured =
        res.status === 400 &&
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        fieldErrors.length === entries.length;
      return {
        detail: fieldErrors
          .map(([k, msgs]) =>
            k === '_errors' ? msgs.join('; ') : `${k}: ${msgs.join('; ')}`,
          )
          .join(' · '),
        validation: structured
          ? {
              fields: Object.fromEntries(
                fieldErrors.filter(([k]) => k !== '_errors'),
              ),
              formErrors: fieldErrors.find(([k]) => k === '_errors')?.[1] ?? [],
            }
          : null,
      };
    }
  } catch {
    // Not JSON — fall through to the raw body.
  }
  return { detail: body, validation: null };
}
