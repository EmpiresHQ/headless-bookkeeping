import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { getToken, setToken, clearToken, apiFetch, TOKEN_KEY } from './auth';

describe('auth token store', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips the token through localStorage', () => {
    expect(getToken()).toBeNull();
    setToken('abc123');
    expect(getToken()).toBe('abc123');
    expect(localStorage.getItem(TOKEN_KEY)).toBe('abc123');
    clearToken();
    expect(getToken()).toBeNull();
  });
});

describe('apiFetch', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('attaches the Bearer header from the stored token', async () => {
    setToken('tok');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    await apiFetch('/api/organization');

    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer tok');
  });

  it('clears the token and throws Unauthorized on 401', async () => {
    setToken('bad');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('nope', { status: 401 }),
    );

    await expect(apiFetch('/api/organization')).rejects.toThrow(/unauthorized/i);
    expect(getToken()).toBeNull();
  });

  it('parses and returns JSON on success', async () => {
    setToken('tok');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"country":"EE"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const body = await apiFetch<{ country: string }>('/api/organization');
    expect(body.country).toBe('EE');
  });
});
