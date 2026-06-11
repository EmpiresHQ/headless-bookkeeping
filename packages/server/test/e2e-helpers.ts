import { INestApplication } from '@nestjs/common';
import { createHash } from 'crypto';
import { Kysely } from 'kysely';
import request from 'supertest';
import { App } from 'supertest/types';

/**
 * Seed a known API token after migrations have run.
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
 * Create a supertest request function that automatically adds the Bearer token.
 * Usage: const req = createAuthedRequest(app, token); await req.post('/api/...').send(...)
 */
export function createAuthedRequest(app: INestApplication<App>, token: string) {
  const server = app.getHttpServer();
  const base = request(server);
  return {
    get: (url: string) => base.get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string) =>
      base.post(url).set('Authorization', `Bearer ${token}`),
    put: (url: string) => base.put(url).set('Authorization', `Bearer ${token}`),
    patch: (url: string) =>
      base.patch(url).set('Authorization', `Bearer ${token}`),
    delete: (url: string) =>
      base.delete(url).set('Authorization', `Bearer ${token}`),
  };
}
