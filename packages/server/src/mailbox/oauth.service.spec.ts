// oauth.service.spec.ts
import { OAuthService } from './oauth.service';

const settings = {
  get: jest.fn(async (k: string) => ({
    google_oauth_client_id: 'cid', google_oauth_client_secret: 'csec', public_api_url: 'https://app.example',
  } as Record<string, string>)[k] ?? null),
} as any;

describe('OAuthService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('builds a Gmail read-only consent URL with the callback redirect', async () => {
    const url = await new OAuthService(settings).authUrl('gmail', 'state123');
    expect(url).toContain('accounts.google.com');
    expect(url).toContain('scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.readonly');
    expect(url).toContain('redirect_uri=https%3A%2F%2Fapp.example%2Fapi%2Fmailbox%2Foauth%2Fcallback');
    expect(url).toContain('access_type=offline');
    expect(url).toContain('state=state123');
  });

  it('exchanges an auth code for a refresh token', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ refresh_token: 'rt-1' }) } as any);
    const { refreshToken } = await new OAuthService(settings).exchangeCode('gmail', 'authcode');
    expect(refreshToken).toBe('rt-1');
  });

  it('mints an access token from a refresh token', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ access_token: 'at-1' }) } as any);
    const at = await new OAuthService(settings).accessToken('gmail', 'rt-1');
    expect(at).toBe('at-1');
  });

  it('throws when the client id is not configured', async () => {
    const empty = { get: jest.fn(async () => null) } as any;
    await expect(new OAuthService(empty).authUrl('gmail', 's')).rejects.toThrow(/client id/i);
  });
});
