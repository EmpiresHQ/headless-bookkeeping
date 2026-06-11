import { describe, it, expect } from 'vitest';
import { runApi, type ApiDeps } from './api.js';

describe('runApi', () => {
  it('forwards method, path, and parsed body to request and prints the result', async () => {
    const calls: unknown[] = [];
    const out: string[] = [];
    const deps: ApiDeps = {
      request: async (method, path, args) => {
        calls.push({ method, path, args });
        return { ok: true, status: 200, body: { pong: true } };
      },
      io: { out: (s) => out.push(s), err: () => {} },
      readFileSync: () => '{"x":1}',
      stdinIsTTY: true,
      readStdin: () => '',
      exit: () => {},
    };
    await runApi({ method: 'post', path: '/api/expenses', 'body-file': '/tmp/x.json' }, deps);
    expect(calls[0]).toMatchObject({
      method: 'post',
      path: '/api/expenses',
      args: { body: { x: 1 } },
    });
    expect(out.join('')).toContain('"pong": true');
  });
});
