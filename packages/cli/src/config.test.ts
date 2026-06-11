import { describe, it, expect } from 'vitest';
import { resolveContext, type CliConfig } from './config.js';

const cfg: CliConfig = {
  currentProfile: 'dev',
  profiles: {
    dev: { baseUrl: 'https://dev.example', token: 'dev-token' },
    prod: { baseUrl: 'https://prod.example', token: 'prod-token' },
  },
};

describe('resolveContext precedence', () => {
  it('uses the active profile when no flags or env are set', () => {
    const ctx = resolveContext({}, {}, cfg);
    expect(ctx).toEqual({
      baseUrl: 'https://dev.example',
      token: 'dev-token',
      profile: 'dev',
    });
  });

  it('selects a named profile via --profile', () => {
    const ctx = resolveContext({ profile: 'prod' }, {}, cfg);
    expect(ctx.baseUrl).toBe('https://prod.example');
    expect(ctx.token).toBe('prod-token');
  });

  it('env overrides the config profile', () => {
    const ctx = resolveContext({}, { HBK_URL: 'https://env', HBK_TOKEN: 'env-tok' }, cfg);
    expect(ctx.baseUrl).toBe('https://env');
    expect(ctx.token).toBe('env-tok');
  });

  it('flags override env and config', () => {
    const ctx = resolveContext(
      { url: 'https://flag', token: 'flag-tok' },
      { HBK_URL: 'https://env', HBK_TOKEN: 'env-tok' },
      cfg,
    );
    expect(ctx.baseUrl).toBe('https://flag');
    expect(ctx.token).toBe('flag-tok');
  });

  it('throws a helpful error when nothing resolves a token', () => {
    expect(() => resolveContext({}, {}, { currentProfile: 'x', profiles: {} })).toThrow(
      /no token/i,
    );
  });
});
