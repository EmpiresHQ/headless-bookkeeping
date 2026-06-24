// oauth.service.spec.ts
import { OAuthService } from './oauth.service';

const settings = {
  get: jest.fn(
    async (k: string) =>
      (
        ({
          google_oauth_client_id: 'cid',
          google_oauth_client_secret: 'csec',
          public_api_url: 'https://app.example',
        }) as Record<string, string>
      )[k] ?? null,
  ),
} as any;

// Minimal unsigned JWT: header.payload.signature, payload carries the claims.
const jwt = (claims: object) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

describe('OAuthService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('builds a Gmail read-only consent URL with openid+email scopes and the callback redirect', async () => {
    const url = await new OAuthService(settings).authUrl('gmail', 'state123');
    expect(url).toContain('accounts.google.com');
    // openid+email alongside the IMAP scope (https://mail.google.com/ is required
    // for XOAUTH2; gmail.readonly only covers the REST API and is rejected by IMAP)
    expect(url).toContain('scope=openid+email');
    expect(url).toContain('mail.google.com');
    expect(url).toContain(
      'redirect_uri=https%3A%2F%2Fapp.example%2Fapi%2Fmailbox%2Foauth%2Fcallback',
    );
    expect(url).toContain('access_type=offline');
    expect(url).toContain('state=state123');
  });

  it('normalizes a trailing slash in public_api_url (no double slash in redirect_uri)', async () => {
    const trailing = {
      get: jest.fn(
        async (k: string) =>
          (
            ({
              google_oauth_client_id: 'cid',
              google_oauth_client_secret: 'csec',
              public_api_url: 'https://app.example/', // trailing slash
            }) as Record<string, string>
          )[k] ?? null,
      ),
    } as never;
    const url = await new OAuthService(trailing).authUrl('gmail', 's');
    expect(url).toContain(
      'redirect_uri=https%3A%2F%2Fapp.example%2Fapi%2Fmailbox%2Foauth%2Fcallback',
    );
    expect(url).not.toContain('%2F%2Fapi'); // no `//api`
  });

  it('exchanges an auth code for a refresh token and the mailbox email (from id_token)', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        refresh_token: 'rt-1',
        id_token: jwt({ email: 'me@gmail.com' }),
      }),
    } as any);
    const { refreshToken, email } = await new OAuthService(
      settings,
    ).exchangeCode('gmail', 'authcode');
    expect(refreshToken).toBe('rt-1');
    expect(email).toBe('me@gmail.com');
  });

  it('throws when the OAuth response carries no email claim', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        refresh_token: 'rt-1',
        id_token: jwt({ sub: 'x' }),
      }),
    } as any);
    await expect(
      new OAuthService(settings).exchangeCode('gmail', 'authcode'),
    ).rejects.toThrow(/email/i);
  });

  it('mints an access token from a refresh token', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'at-1' }),
    } as any);
    const at = await new OAuthService(settings).accessToken('gmail', 'rt-1');
    expect(at).toBe('at-1');
  });

  it('throws when the client id is not configured', async () => {
    const empty = { get: jest.fn(async () => null) } as any;
    await expect(new OAuthService(empty).authUrl('gmail', 's')).rejects.toThrow(
      /client id/i,
    );
  });
});
