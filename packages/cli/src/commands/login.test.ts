import { describe, it, expect, vi } from 'vitest';
import { runLogin, type LoginDeps } from './login.js';

function deps(overrides: Partial<LoginDeps> = {}): {
  deps: LoginDeps;
  saved: { name: string; baseUrl: string; token: string }[];
  err: string[];
} {
  const saved: { name: string; baseUrl: string; token: string }[] = [];
  const err: string[] = [];
  return {
    saved,
    err,
    deps: {
      validate: vi.fn(async () => 200),
      saveProfile: (name, baseUrl, token) => saved.push({ name, baseUrl, token }),
      io: { out: () => {}, err: (s) => err.push(s) },
      ...overrides,
    },
  };
}

describe('runLogin', () => {
  it('validates then saves the profile on 200', async () => {
    const { deps: d, saved } = deps();
    const code = await runLogin(
      { url: 'https://api.example', token: 'tok', profile: 'dev' },
      d,
    );
    expect(code).toBe(0);
    expect(d.validate).toHaveBeenCalledWith('https://api.example', 'tok');
    expect(saved).toEqual([{ name: 'dev', baseUrl: 'https://api.example', token: 'tok' }]);
  });

  it('does not save and returns 1 when validation is 401', async () => {
    const { deps: d, saved, err } = deps({ validate: vi.fn(async () => 401) });
    const code = await runLogin({ url: 'https://api.example', token: 'bad' }, d);
    expect(code).toBe(1);
    expect(saved).toEqual([]);
    expect(err.join('')).toMatch(/401|invalid|rejected/i);
  });

  it('defaults the profile name to "default"', async () => {
    const { deps: d, saved } = deps();
    await runLogin({ url: 'https://api.example', token: 'tok' }, d);
    expect(saved[0].name).toBe('default');
  });
});
