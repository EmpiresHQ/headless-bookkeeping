import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { Database } from '../database/types';

/**
 * SHA-256 hash a plaintext token.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time comparison of two hex strings.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Generate a random token string (32 bytes → 64 hex chars).
 */
function generateToken(): string {
  return randomBytes(32).toString('hex');
}

@Injectable()
export class ApiTokenService implements OnModuleInit {
  private readonly logger = new Logger(ApiTokenService.name);

  constructor(
    @InjectKysely()
    private readonly db: Kysely<Database>,
  ) {}

  async onModuleInit(): Promise<void> {
    // Generate one init token at boot if no tokens exist.
    const existing = await this.db
      .selectFrom('api_token')
      .select('id')
      .limit(1)
      .execute();

    if (existing.length === 0) {
      const plaintext = generateToken();
      const tokenHash = hashToken(plaintext);

      await this.db
        .insertInto('api_token')
        .values({
          token_hash: tokenHash,
          label: 'init-token',
        })
        .execute();

      this.logger.warn(
        `INIT API TOKEN (log once, store securely): ${plaintext}`,
      );
    }
  }

  /**
   * Create a new API token. Returns the plaintext token (store it securely)
   * and the row id.
   */
  async create(label: string): Promise<{ id: number; token: string }> {
    const plaintext = generateToken();
    const tokenHash = hashToken(plaintext);

    const result = await this.db
      .insertInto('api_token')
      .values({
        token_hash: tokenHash,
        label,
      })
      .executeTakeFirst();

    return { id: Number(result.insertId), token: plaintext };
  }

  /**
   * Verify a plaintext token against the database.
   * Returns the token row if valid and not revoked, null otherwise.
   */
  async verify(plaintext: string): Promise<{
    id: number;
    token_hash: string;
    label: string | null;
    created_at: number;
    revoked_at: number | null;
    kind: string;
    expires_at: number | null;
    consumed_at: number | null;
  } | null> {
    const candidateHash = hashToken(plaintext);
    const now = Math.floor(Date.now() / 1000);

    const tokens = await this.db
      .selectFrom('api_token')
      .select([
        'id',
        'token_hash',
        'label',
        'created_at',
        'revoked_at',
        'kind',
        'expires_at',
        'consumed_at',
      ])
      .where('revoked_at', 'is', null)
      .where('consumed_at', 'is', null)
      .where((eb) =>
        eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]),
      )
      .execute();

    for (const token of tokens) {
      if (constantTimeEqual(candidateHash, token.token_hash)) {
        return token;
      }
    }

    return null;
  }

  /**
   * List all tokens with safe metadata only — never the hash or plaintext.
   */
  async list(): Promise<
    Array<{
      id: number;
      label: string | null;
      created_at: number;
      revoked_at: number | null;
    }>
  > {
    return this.db
      .selectFrom('api_token')
      .select(['id', 'label', 'created_at', 'revoked_at'])
      .orderBy('id', 'asc')
      .execute();
  }

  /**
   * Revoke a token by id.
   */
  async revoke(id: number): Promise<void> {
    await this.db
      .updateTable('api_token')
      .set({ revoked_at: Math.floor(Date.now() / 1000) })
      .where('id', '=', id)
      .execute();
  }
}
