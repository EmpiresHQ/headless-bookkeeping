import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { DocumentUrlSignerService } from './document-url-signer.service';

describe('DocumentUrlSignerService', () => {
  let db: Kysely<Database>;
  let signer: DocumentUrlSignerService;

  beforeEach(async () => {
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: async () => migrations },
    });
    await migrator.migrateToLatest();
    signer = new DocumentUrlSignerService(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('signs and verifies a document id within its TTL', async () => {
    const { exp, sig } = await signer.sign(110, 3600);
    expect(exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(await signer.verify(110, exp, sig)).toBe(true);
  });

  it('rejects a tampered document id', async () => {
    const { exp, sig } = await signer.sign(110, 3600);
    // Same signature, different document id → must not verify.
    expect(await signer.verify(111, exp, sig)).toBe(false);
  });

  it('rejects a tampered signature', async () => {
    const { exp } = await signer.sign(110, 3600);
    const bad = 'f'.repeat(64);
    expect(await signer.verify(110, exp, bad)).toBe(false);
  });

  it('rejects an expired signature', async () => {
    // Negative TTL → exp already in the past.
    const { exp, sig } = await signer.sign(110, -10);
    expect(await signer.verify(110, exp, sig)).toBe(false);
  });

  it('persists the signing key so signatures survive a fresh service instance', async () => {
    const { exp, sig } = await signer.sign(110, 3600);
    // A new instance must load the SAME key from the setting table, not mint a
    // fresh one (which would invalidate every already-issued link).
    const signer2 = new DocumentUrlSignerService(db);
    expect(await signer2.verify(110, exp, sig)).toBe(true);
  });

  it('builds a relative shared URL carrying exp and sig', async () => {
    const url = await signer.buildSharedUrl(110, 3600);
    expect(url).toMatch(
      /^\/api\/documents\/110\/shared\?exp=\d+&sig=[0-9a-f]{64}$/,
    );
  });
});
