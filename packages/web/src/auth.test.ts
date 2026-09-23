import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  getToken,
  setToken,
  clearToken,
  apiFetch,
  isCurrentUnauthorized,
  SessionChangedError,
  TOKEN_KEY,
  UnauthorizedError,
} from './auth';

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

    const err = await apiFetch('/api/organization').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(getToken()).toBeNull();
    // It ended the current session: the shell may sign out on it...
    expect(isCurrentUnauthorized(err)).toBe(true);
    // ...until a newer sign-in makes it history.
    setToken('next');
    expect(isCurrentUnauthorized(err)).toBe(false);
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

  it('surfaces the NestJS message from an error body (not the raw JSON)', async () => {
    setToken('tok');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          statusCode: 409,
          message: 'Expense 7 is posted; only a draft can be deleted',
          error: 'Conflict',
        }),
        { status: 409, statusText: 'Conflict' },
      ),
    );

    await expect(
      apiFetch('/api/expenses/7', { method: 'DELETE' }),
    ).rejects.toThrow(/only a draft can be deleted/);
  });

  it('renders the Zod pipe field-error body as "field: message"', async () => {
    setToken('tok');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          gross_amount: ['must be greater than zero'],
          _errors: ['document_id is the source document (provenance)'],
        }),
        { status: 400, statusText: 'Bad Request' },
      ),
    );

    await expect(
      apiFetch('/api/expenses/7', { method: 'PATCH' }),
    ).rejects.toThrow(
      '400 Bad Request: gross_amount: must be greater than zero · document_id is the source document (provenance)',
    );
  });
});

/** A Response whose body read is held until the test releases it. */
function heldBody(status: number, body: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const res = new Response(body, { status });
  const read = async () => {
    await gate;
    return body;
  };
  Object.defineProperty(res, 'text', { value: read });
  Object.defineProperty(res, 'json', {
    value: async () => JSON.parse(await read()) as unknown,
  });
  return { res, release };
}

describe('apiFetch session ownership (#251)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  const signInAgain = (token: string) => {
    clearToken(); // forced 401 elsewhere
    setToken(token); // new sign-in
  };

  it('a late 401 of an ENDED session never clears the new token', async () => {
    setToken('a');
    let reply!: (r: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockReturnValue(
      new Promise((r) => (reply = r)),
    );
    const p = apiFetch('/api/expenses', { method: 'POST' });
    signInAgain('b');
    reply(new Response('{"message":"no"}', { status: 401 }));
    await expect(p).rejects.toBeInstanceOf(SessionChangedError);
    expect(getToken()).toBe('b');
  });

  it('a 401 after ANOTHER TAB replaced the token (no revision bump here) is not ours either', async () => {
    setToken('a');
    let reply!: (r: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockReturnValue(
      new Promise((r) => (reply = r)),
    );
    const p = apiFetch('/api/expenses', { method: 'POST' });
    localStorage.setItem(TOKEN_KEY, 'other-tab');
    reply(new Response('{"message":"no"}', { status: 401 }));
    await expect(p).rejects.toBeInstanceOf(SessionChangedError);
    expect(getToken()).toBe('other-tab');
  });

  it('a success whose JSON body is still being read when the session changes is not delivered', async () => {
    setToken('a');
    const { res, release } = heldBody(200, '{"id":24}');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(res);
    const p = apiFetch('/api/expenses', { method: 'POST' });
    await new Promise((r) => setTimeout(r, 0)); // headers are in
    signInAgain('b');
    release();
    await expect(p).rejects.toBeInstanceOf(SessionChangedError);
  });

  it('an error whose body is still being read when the session changes is not delivered as an error', async () => {
    setToken('a');
    const { res, release } = heldBody(503, '{"message":"Old failure"}');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(res);
    const p = apiFetch('/api/expenses', { method: 'POST' });
    await new Promise((r) => setTimeout(r, 0));
    localStorage.setItem(TOKEN_KEY, 'other-tab');
    release();
    await expect(p).rejects.toBeInstanceOf(SessionChangedError);
  });

  it('a network failure after the session changed is not the new session’s error', async () => {
    setToken('a');
    let fail!: (e: unknown) => void;
    vi.spyOn(globalThis, 'fetch').mockReturnValue(
      new Promise((_, rej) => (fail = rej)),
    );
    const p = apiFetch('/api/organization');
    signInAgain('b');
    fail(new TypeError('Failed to fetch'));
    await expect(p).rejects.toBeInstanceOf(SessionChangedError);
  });

  it('the same session still gets its data and its errors', async () => {
    setToken('a');
    const { res, release } = heldBody(200, '{"id":24}');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(res);
    const p = apiFetch<{ id: number }>('/api/expenses', { method: 'POST' });
    release();
    await expect(p).resolves.toEqual({ id: 24 });
  });
});
