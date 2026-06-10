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
    throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}
