import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeRequest } from './client.js';

afterEach(() => vi.restoreAllMocks());

function stubFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    // openapi-fetch v0.13 passes a Request object as the first arg (not a plain string URL).
    // Headers are normalised to lowercase by the Headers API, so we reconstruct
    // a plain object with a Proxy so that both `headers.Authorization` and
    // `headers.authorization` resolve to the same value.
    vi.fn(async (input: string | Request, init: RequestInit = {}) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = req.url;
      const rawHeaders: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        rawHeaders[key] = value; // keys are lowercased by the Headers API
      });
      // Proxy so case-insensitive lookup works (the test uses 'Authorization')
      const headers = new Proxy(rawHeaders, {
        get(target, prop: string) {
          return target[prop] ?? target[prop.toLowerCase()];
        },
      }) as Record<string, string>;
      calls.push({ url, init: { ...init, headers } });
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

describe('makeRequest', () => {
  it('sends Bearer auth, substitutes path params, appends query, returns body', async () => {
    const calls = stubFetch(200, { id: 7 });
    const request = makeRequest({
      baseUrl: 'https://api.example',
      token: 'tok',
      profile: 'dev',
    });

    const res = await request('get', '/api/expenses/{id}', {
      pathParams: { id: '7' },
      query: { include: 'voucher' },
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 7 });

    const { url, init } = calls[0];
    expect(url).toBe('https://api.example/api/expenses/7?include=voucher');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('marks ok=false on >=400 and returns the error body', async () => {
    stubFetch(404, { message: 'not found' });
    const request = makeRequest({ baseUrl: 'https://api.example', token: 't', profile: 'dev' });
    const res = await request('get', '/api/expenses/{id}', { pathParams: { id: '1' } });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'not found' });
  });
});
