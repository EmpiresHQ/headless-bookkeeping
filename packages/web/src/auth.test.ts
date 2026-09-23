import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  getToken,
  setToken,
  clearToken,
  apiFetch,
  isCurrentUnauthorized,
  SessionChangedError,
  TOKEN_KEY,
  SESSION_ID_KEY,
  HttpError,
  currentSessionId,
  UnauthorizedError,
  checkToken,
  sessionStamp,
  isSameSession,
  AUTH_EPOCH_KEY,
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

describe('session id (#254)', () => {
  beforeEach(() => localStorage.clear());

  it('every sign-in mints a new random id; sign-out removes it', () => {
    expect(currentSessionId()).toBeNull();
    setToken('a');
    const first = currentSessionId();
    expect(first).toEqual(expect.any(String));
    expect(currentSessionId()).toBe(first);
    setToken('a'); // even the same token is a new sign-in
    expect(currentSessionId()).not.toBe(first);
    clearToken();
    expect(localStorage.getItem(SESSION_ID_KEY)).toBeNull();
    expect(currentSessionId()).toBeNull();
  });

  it('a token stored before session ids existed gets one lazily', () => {
    localStorage.setItem(TOKEN_KEY, 'legacy');
    const id = currentSessionId();
    expect(id).toEqual(expect.any(String));
    expect(id).not.toContain('legacy');
    expect(currentSessionId()).toBe(id);
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

  it('a non-OK answer is an HttpError carrying its status and the same message', async () => {
    setToken('tok');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"message":"Import job 41 not found"}', {
        status: 404,
        statusText: 'Not Found',
      }),
    );
    const err = await apiFetch('/api/bank-statements/import/41').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
    expect((err as Error).message).toBe(
      '404 Not Found: Import job 41 not found',
    );
  });

  it('a 404 whose session ended in flight is still SessionChangedError, not HttpError', async () => {
    setToken('a');
    const { res, release } = heldBody(404, '{"message":"gone"}');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(res);
    const p = apiFetch('/api/bank-statements/import/41');
    await new Promise((r) => setTimeout(r, 0));
    setToken('b');
    release();
    await expect(p).rejects.toBeInstanceOf(SessionChangedError);
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

  describe('structured validation detail (#265)', () => {
    const fail = async (body: string, status = 400, statusText = 'Bad') => {
      setToken('tok');
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(body, { status, statusText }),
      );
      const err = await apiFetch('/api/expenses', { method: 'POST' }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(HttpError);
      return err as HttpError;
    };

    it("keeps the Zod pipe's flat 400 object as fields + _errors, message unchanged", async () => {
      const err = await fail(
        JSON.stringify({
          gross_amount: ['must be greater than zero'],
          _errors: ['Invalid input'],
        }),
        400,
        'Bad Request',
      );
      expect(err.status).toBe(400);
      expect(err.message).toBe(
        '400 Bad Request: gross_amount: must be greater than zero · Invalid input',
      );
      expect(err.validation).toEqual({
        fields: { gross_amount: ['must be greater than zero'] },
        formErrors: ['Invalid input'],
      });
    });

    it('a Nest {message} error names no field, even if it mentions one', async () => {
      const err = await fail(
        JSON.stringify({
          statusCode: 400,
          message: "Unknown category 'x'. Valid categories: a",
          error: 'Bad Request',
        }),
      );
      expect(err.validation).toBeNull();
      expect(err.message).toBe(
        "400 Bad: Unknown category 'x'. Valid categories: a",
      );
    });

    it('a Nest message array names no field', async () => {
      const err = await fail(JSON.stringify({ message: ['a', 'b'] }));
      expect(err.validation).toBeNull();
      expect(err.message).toBe('400 Bad: a; b');
    });

    it('free text is never read as fields', async () => {
      const err = await fail('gross_amount: bad');
      expect(err.validation).toBeNull();
      expect(err.message).toBe('400 Bad: gross_amount: bad');
    });

    it('a mixed object (not every value a string array) is not structured', async () => {
      const err = await fail(
        JSON.stringify({ gross_amount: ['bad'], statusCode: 400 }),
      );
      expect(err.validation).toBeNull();
      expect(err.message).toBe('400 Bad: gross_amount: bad');
    });

    it('an array of string arrays is not structured', async () => {
      const err = await fail(JSON.stringify([['bad'], ['worse']]));
      expect(err.validation).toBeNull();
    });

    it('the flat shape on a non-400 status (e.g. 422) is not structured', async () => {
      const err = await fail(
        JSON.stringify({ gross_amount: ['bad'] }),
        422,
        'Unprocessable Entity',
      );
      expect(err.validation).toBeNull();
      expect(err.message).toBe('422 Unprocessable Entity: gross_amount: bad');
    });

    it('JSON null is not structured', async () => {
      const err = await fail('null');
      expect(err.validation).toBeNull();
    });
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

describe('same-token sign-in in another tab (#285)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  /** What another tab's setToken leaves behind: storage only, no event
   *  delivered here yet, this tab's revision untouched. */
  const otherTabSignsInWith = (token: string) => {
    localStorage.setItem(SESSION_ID_KEY, 'other-tab-session');
    localStorage.setItem(TOKEN_KEY, token);
  };

  it('a 401 settling after the session id changed does not clear the other tab’s sign-in', async () => {
    setToken('same');
    let reply!: (r: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockReturnValue(
      new Promise((r) => (reply = r)),
    );
    const p = apiFetch('/api/expenses', { method: 'POST' });
    otherTabSignsInWith('same');
    reply(new Response('{"message":"no"}', { status: 401 }));
    await expect(p).rejects.toBeInstanceOf(SessionChangedError);
    expect(getToken()).toBe('same');
    expect(localStorage.getItem(SESSION_ID_KEY)).toBe('other-tab-session');
  });

  it('a body still being read when the session id changes is not delivered', async () => {
    setToken('same');
    const { res, release } = heldBody(200, '{"id":24}');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(res);
    const p = apiFetch('/api/expenses', { method: 'POST' });
    await new Promise((r) => setTimeout(r, 0));
    otherTabSignsInWith('same');
    release();
    await expect(p).rejects.toBeInstanceOf(SessionChangedError);
  });

  it('an orphan id left without a token is one unchanged signed-out state (a check started there can commit)', () => {
    localStorage.setItem(SESSION_ID_KEY, 'orphan');
    const stamp = sessionStamp();
    expect(stamp).toMatchObject({ token: null, id: 'orphan' });
    expect(isSameSession(stamp)).toBe(true);
    expect(localStorage.getItem(SESSION_ID_KEY)).toBe('orphan');
  });

  it('signed out, then signed in and out again by another context: token and id end as they began, yet it is not the same session', async () => {
    const stamp = sessionStamp();
    expect(stamp).toMatchObject({ token: null, id: null });
    vi.resetModules();
    const other = await import('./auth');
    other.setToken('b');
    other.clearToken();
    expect(getToken()).toBeNull();
    expect(currentSessionId()).toBeNull(); // still signed out, no id
    expect(localStorage.getItem(AUTH_EPOCH_KEY)).toEqual(expect.any(String));
    expect(isSameSession(stamp)).toBe(false);
  });

  it.each([
    ['sign-in', () => setToken('b')],
    ['sign-out', () => clearToken()],
  ])(
    '%s advances the epoch before token or id change (no midway state under the old epoch)',
    (_label, transition) => {
      setToken('a');
      const before = localStorage.getItem(AUTH_EPOCH_KEY);
      const midway: (string | null)[] = [];
      const record = () => midway.push(localStorage.getItem(AUTH_EPOCH_KEY));
      const set = Storage.prototype.setItem;
      const remove = Storage.prototype.removeItem;
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
        this: Storage,
        key: string,
        value: string,
      ) {
        if (key !== AUTH_EPOCH_KEY) record();
        set.call(this, key, value);
      });
      vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (
        this: Storage,
        key: string,
      ) {
        record();
        remove.call(this, key);
      });
      transition();
      expect(midway.length).toBeGreaterThan(0);
      for (const epoch of midway) expect(epoch).not.toBe(before);
    },
  );

  it('a token stored before ids existed: the id minted at the first stamp keeps it the same session', async () => {
    localStorage.setItem(TOKEN_KEY, 'legacy');
    const stamp = sessionStamp();
    expect(stamp.id).toEqual(expect.any(String));
    expect(currentSessionId()).toBe(stamp.id); // no second mint
    expect(isSameSession(stamp)).toBe(true);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', { status: 200 }),
    );
    await expect(apiFetch('/api/expenses')).resolves.toEqual({ ok: true });
  });
});

describe('checkToken (#285)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  const answer = (r: Response | Error) =>
    vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        r instanceof Error ? Promise.reject(r) : Promise.resolve(r),
      );

  it('sends the candidate once, uncached, without storing it', async () => {
    const fetchMock = answer(new Response('{"entities":[]}', { status: 200 }));
    await expect(checkToken('candidate')).resolves.toBe('accepted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/entities');
    expect(init?.cache).toBe('no-store');
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer candidate',
    );
    expect(getToken()).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it('only a 401 is a rejection; other statuses and network errors are "could not check"', async () => {
    answer(
      new Response('{"message":"Invalid or revoked API token"}', {
        status: 401,
      }),
    );
    await expect(checkToken('x')).resolves.toBe('rejected');
    vi.restoreAllMocks();
    answer(new Response('down', { status: 503 }));
    await expect(checkToken('x')).resolves.toBe('unavailable');
    vi.restoreAllMocks();
    answer(new TypeError('Failed to fetch'));
    await expect(checkToken('x')).resolves.toBe('unavailable');
  });

  it('a 401 does not touch a token stored by someone else', async () => {
    setToken('stored');
    answer(new Response('no', { status: 401 }));
    await expect(checkToken('candidate')).resolves.toBe('rejected');
    expect(getToken()).toBe('stored');
  });

  it('an aborted check rejects instead of giving a verdict', async () => {
    const ctrl = new AbortController();
    let reply!: (r: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockReturnValue(
      new Promise((r) => (reply = r)),
    );
    const p = checkToken('x', ctrl.signal);
    ctrl.abort();
    reply(new Response('{}', { status: 200 }));
    await expect(p).rejects.toThrow();
  });
});
