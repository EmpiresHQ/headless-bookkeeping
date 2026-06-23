// oauth.service.ts
import { Injectable } from '@nestjs/common';
import { SettingsService } from '../admin/settings.service';

type Prov = 'gmail' | 'outlook';

// `openid email` is requested alongside the IMAP scope so the token response
// carries an id_token we can read the mailbox address from — the operator never
// types their own email; it comes back from the provider after consent.
const CFG = {
  gmail: {
    auth: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email https://www.googleapis.com/auth/gmail.readonly',
    idKey: 'google_oauth_client_id',
    secretKey: 'google_oauth_client_secret',
  },
  outlook: {
    auth: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope:
      'openid email offline_access https://outlook.office365.com/IMAP.AccessAsUser.All',
    idKey: 'microsoft_oauth_client_id',
    secretKey: 'microsoft_oauth_client_secret',
  },
} as const;

// Read the mailbox address from an OIDC id_token (the JWT payload). The token
// comes directly from the provider's token endpoint over server-to-server TLS,
// so we trust it without re-verifying the signature.
export function emailFromIdToken(idToken: string | undefined): string | null {
  const payload = idToken?.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as { email?: string; preferred_username?: string; upn?: string };
    return claims.email ?? claims.preferred_username ?? claims.upn ?? null;
  } catch {
    return null;
  }
}

@Injectable()
export class OAuthService {
  constructor(private readonly settings: SettingsService) {}

  private async cfg(provider: Prov) {
    const c = CFG[provider];
    const clientId = await this.settings.get(c.idKey);
    const clientSecret = await this.settings.get(c.secretKey);
    if (!clientId)
      throw new Error(`OAuth client id for ${provider} is not configured`);
    const base = (await this.settings.get('public_api_url')) ?? '';
    return {
      ...c,
      clientId,
      clientSecret: clientSecret ?? '',
      redirect: `${base}/api/mailbox/oauth/callback`,
    };
  }

  async authUrl(provider: Prov, state: string): Promise<string> {
    const c = await this.cfg(provider);
    const p = new URLSearchParams({
      client_id: c.clientId,
      redirect_uri: c.redirect,
      response_type: 'code',
      scope: c.scope,
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `${c.auth}?${p.toString()}`;
  }

  async exchangeCode(
    provider: Prov,
    code: string,
  ): Promise<{ refreshToken: string; email: string }> {
    const c = await this.cfg(provider);
    const res = await fetch(c.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: c.clientId,
        client_secret: c.clientSecret,
        redirect_uri: c.redirect,
        grant_type: 'authorization_code',
      }),
    });
    if (!res.ok) throw new Error(`OAuth code exchange failed: ${res.status}`);
    const j = (await res.json()) as {
      refresh_token?: string;
      id_token?: string;
    };
    if (!j.refresh_token)
      throw new Error('OAuth response missing refresh_token');
    const email = emailFromIdToken(j.id_token);
    if (!email)
      throw new Error(
        'OAuth response did not include an email address (the app must request the openid+email scopes)',
      );
    return { refreshToken: j.refresh_token, email };
  }

  async accessToken(provider: Prov, refreshToken: string): Promise<string> {
    const c = await this.cfg(provider);
    const res = await fetch(c.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: c.clientId,
        client_secret: c.clientSecret,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) throw new Error(`OAuth refresh failed: ${res.status}`);
    const j = (await res.json()) as { access_token?: string };
    if (!j.access_token) throw new Error('OAuth response missing access_token');
    return j.access_token;
  }
}
