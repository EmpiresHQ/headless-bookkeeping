import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { Database } from '../database/types';

/**
 * The `setting` row that holds the HMAC key used to sign shareable document
 * URLs. It is an INTERNAL secret — generated on first use and never exposed
 * through the admin settings API (which only knows the user-facing registry).
 */
const SIGNING_KEY_SETTING = 'document_url_signing_key';

/** Default link lifetime (seconds) when a caller does not specify one. */
export const DEFAULT_SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour

/**
 * DocumentUrlSignerService — mints and validates short-lived, signed URLs that
 * grant access to a single document's bytes WITHOUT an API token.
 *
 * The document file endpoint is otherwise Bearer-only (the global ApiTokenGuard),
 * so a plain <a href> in the browser cannot open it (the token lives in
 * localStorage, not a cookie). A signed URL closes that gap: it carries an
 * expiry and an HMAC over `${documentId}.${exp}` in the query string, so the
 * public `/shared` route can authorize the single document for a bounded window
 * — copy-paste-shareable, self-expiring, and scoped to one document.
 *
 * The signing key is a 32-byte random secret persisted in the `setting` table,
 * auto-generated on first use (mirrors how ApiTokenService mints tokens). It is
 * cached in memory after the first load. Rotating it (delete the row) instantly
 * invalidates every outstanding link.
 */
@Injectable()
export class DocumentUrlSignerService {
  private cachedKey: string | null = null;

  constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

  private nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }

  /**
   * Load the signing key, generating and persisting it on first use. Written
   * directly to the `setting` table (NOT via SettingsService.set, which only
   * accepts user-facing registry keys) with onConflict-do-nothing so two
   * concurrent first-uses converge on a single key rather than racing.
   */
  private async getKey(): Promise<string> {
    if (this.cachedKey) return this.cachedKey;

    const existing = await this.db
      .selectFrom('setting')
      .select('value')
      .where('key', '=', SIGNING_KEY_SETTING)
      .executeTakeFirst();
    if (existing?.value) {
      this.cachedKey = existing.value;
      return existing.value;
    }

    const fresh = randomBytes(32).toString('hex');
    await this.db
      .insertInto('setting')
      .values({
        key: SIGNING_KEY_SETTING,
        value: fresh,
        updated_at: this.nowSeconds(),
      })
      .onConflict((oc) => oc.column('key').doNothing())
      .execute();

    // Re-read so a concurrent insert's winning value is the one we cache/use.
    const row = await this.db
      .selectFrom('setting')
      .select('value')
      .where('key', '=', SIGNING_KEY_SETTING)
      .executeTakeFirst();
    this.cachedKey = row?.value ?? fresh;
    return this.cachedKey;
  }

  private async computeSig(documentId: number, exp: number): Promise<string> {
    const key = await this.getKey();
    return createHmac('sha256', key)
      .update(`${documentId}.${exp}`)
      .digest('hex');
  }

  /**
   * Sign a document id for `ttlSeconds`, returning the expiry timestamp and the
   * HMAC signature to embed in a `/shared` URL's query string.
   */
  async sign(
    documentId: number,
    ttlSeconds: number = DEFAULT_SIGNED_URL_TTL_SECONDS,
  ): Promise<{ exp: number; sig: string }> {
    const exp = this.nowSeconds() + ttlSeconds;
    const sig = await this.computeSig(documentId, exp);
    return { exp, sig };
  }

  /**
   * Verify a signed access claim: the expiry must be in the future and the
   * signature must match (constant-time) the HMAC over `${documentId}.${exp}`.
   */
  async verify(documentId: number, exp: number, sig: string): Promise<boolean> {
    if (!Number.isFinite(exp) || exp < this.nowSeconds()) return false;
    if (typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) return false;
    const expected = await this.computeSig(documentId, exp);
    return timingSafeEqual(
      Buffer.from(sig, 'hex'),
      Buffer.from(expected, 'hex'),
    );
  }

  /**
   * Build the relative shareable URL for a document — the public `/shared`
   * route plus the signed `exp`/`sig` query params. Relative so it works behind
   * any host/proxy; the SPA/operator can prefix the origin to share it.
   */
  async buildSharedUrl(
    documentId: number,
    ttlSeconds: number = DEFAULT_SIGNED_URL_TTL_SECONDS,
  ): Promise<string> {
    const { exp, sig } = await this.sign(documentId, ttlSeconds);
    return `/api/documents/${documentId}/shared?exp=${exp}&sig=${sig}`;
  }
}
