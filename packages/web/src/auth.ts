export const TOKEN_KEY = 'bk_api_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** Raised on a 401 so the UI can drop back to the token gate. */
export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized — token cleared');
    this.name = 'UnauthorizedError';
  }
}

/**
 * fetch wrapper that attaches the stored Bearer token, surfaces a 401 by
 * clearing the token and throwing UnauthorizedError, and returns parsed JSON.
 */
export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(path, { ...init, headers });

  if (res.status === 401) {
    clearToken();
    throw new UnauthorizedError();
  }
  if (!res.ok) {
    throw new Error(
      `${res.status} ${res.statusText}: ${await errorDetail(res)}`,
    );
  }
  // P1 only calls JSON GET endpoints, so we always parse. When P2 adds
  // mutations that may return 204 No Content, this must grow an empty-body
  // guard (and a test) before such a call is made.
  return (await res.json()) as T;
}

/**
 * Like apiFetch but returns the raw Response instead of parsed JSON.
 * Used for binary/blob downloads (e.g. statutory-report XML/ZIP).
 */
export async function apiFetchRaw(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(path, { ...init, headers });

  if (res.status === 401) {
    clearToken();
    throw new UnauthorizedError();
  }
  if (!res.ok) {
    throw new Error(
      `${res.status} ${res.statusText}: ${await errorDetail(res)}`,
    );
  }
  return res;
}

/**
 * Extract a human-readable detail from an error response. NestJS errors return
 * `{ statusCode, message, error }` where `message` is a string (or string[] for
 * validation errors); prefer that over the raw JSON blob. Falls back to the raw
 * body when it is not the expected JSON shape.
 */
async function errorDetail(res: Response): Promise<string> {
  const body = await res.text();
  try {
    const parsed = JSON.parse(body) as { message?: string | string[] };
    if (parsed.message) {
      return Array.isArray(parsed.message)
        ? parsed.message.join('; ')
        : parsed.message;
    }
  } catch {
    // Not JSON — fall through to the raw body.
  }
  return body;
}
