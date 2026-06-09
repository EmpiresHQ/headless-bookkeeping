import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { ApiTokenService } from '../auth/api-token.service';
import { buildTokenCli } from './token-cli';

function makeIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

describe('token CLI (yargs)', () => {
  let db: Kysely<Database>;
  let tokens: ApiTokenService;

  beforeEach(async () => {
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error)
      throw error instanceof Error ? error : new Error('Migration failed');
    tokens = new ApiTokenService(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('create prints a plaintext token (stdout) that verifies', async () => {
    const { io, out, err } = makeIo();
    await buildTokenCli(tokens, io).parseAsync([
      'token',
      'create',
      '--label',
      'agent',
    ]);
    const token = out().trim();
    expect(token).toHaveLength(64);
    expect(err()).toContain('label=agent');
    expect(await tokens.verify(token)).not.toBeNull();
  });

  it('list returns all tokens as JSON without secrets', async () => {
    await buildTokenCli(tokens, makeIo().io).parseAsync([
      'token',
      'create',
      '--label',
      'a',
    ]);
    await buildTokenCli(tokens, makeIo().io).parseAsync([
      'token',
      'create',
      '--label',
      'b',
    ]);
    const { io, out } = makeIo();
    await buildTokenCli(tokens, io).parseAsync(['token', 'list']);
    const rows = JSON.parse(out()) as Array<{ id: number; label: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.label)).toEqual(
      expect.arrayContaining(['a', 'b']),
    );
    expect(out()).not.toContain('token_hash');
  });

  it('revoke invalidates the token', async () => {
    const c = makeIo();
    await buildTokenCli(tokens, c.io).parseAsync(['token', 'create']);
    const token = c.out().trim();
    const id = Number(/id=(\d+)/.exec(c.err())?.[1]);

    await buildTokenCli(tokens, makeIo().io).parseAsync([
      'token',
      'revoke',
      String(id),
    ]);
    expect(await tokens.verify(token)).toBeNull();
  });

  // yargs surfaces validation errors synchronously via .fail; the entrypoint
  // wraps parseAsync in try/catch, so this helper accepts a sync throw OR reject.
  async function expectFailure(run: () => Promise<unknown>): Promise<void> {
    let threw = false;
    try {
      await run();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  }

  it('revoke with a non-numeric id fails with a clear message', async () => {
    const { io, err } = makeIo();
    await expectFailure(() =>
      buildTokenCli(tokens, io).parseAsync(['token', 'revoke', 'nope']),
    );
    expect(err()).toMatch(/numeric <id>/);
  });

  it('unknown command fails and prints usage', async () => {
    const { io, err } = makeIo();
    await expectFailure(() =>
      buildTokenCli(tokens, io).parseAsync(['token', 'bogus']),
    );
    expect(err().length).toBeGreaterThan(0);
  });
});
