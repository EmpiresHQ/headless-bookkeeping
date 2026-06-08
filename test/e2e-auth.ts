import { Kysely } from 'kysely';
import { createHash } from 'crypto';

/**
 * Shared helper for e2e tests: seeds a known API token into the database
 * after migrations have run, and returns the token string for use in requests.
 */
export async function seedApiToken(db: Kysely<any>): Promise<string> {
  const token = 'test-token-e2e-12345';
  const tokenHash = createHash('sha256').update(token).digest('hex');
  await db
    .insertInto('api_token')
    .values({ token_hash: tokenHash, label: 'e2e-test' })
    .execute();
  return token;
}

/**
 * Supertest request extension that adds the Bearer token header.
 */
export function auth(
  req: { set: (header: string, value: string) => any },
  token: string,
) {
  return req.set('Authorization', `Bearer ${token}`);
}
