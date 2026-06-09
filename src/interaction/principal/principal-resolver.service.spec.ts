import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { Database } from '../../database/types';
import { migrations } from '../../database/migrations';
import { InteractionConfigService } from '../config/interaction-config.service';
import { PrincipalResolverService } from './principal-resolver.service';
import { UnifiedEnvelope } from '../envelope/types';

function tgEnvelope(chatId: string, verified: boolean): UnifiedEnvelope {
  return {
    channel: 'telegram',
    sender: chatId,
    convKey: `tg:${chatId}`,
    message: 'hi',
    attachments: [],
    metadata: {},
    auth: { senderId: chatId, transportVerified: verified },
  };
}

describe('PrincipalResolverService (integration)', () => {
  let db: Kysely<Database>;
  let resolver: PrincipalResolverService;

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
      throw error instanceof Error ? error : new Error('migrate failed');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        InteractionConfigService,
        PrincipalResolverService,
      ],
    }).compile();
    resolver = module.get(PrincipalResolverService);

    await db
      .insertInto('setting')
      .values({ key: 'telegram_allowlist', value: '999', updated_at: 0 })
      .execute();
    await db
      .insertInto('setting')
      .values({ key: 'approvers', value: '999', updated_at: 0 })
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('resolves an allowlisted, transport-verified telegram sender as an authVerified approver', async () => {
    const p = await resolver.resolve(tgEnvelope('999', true));
    expect(p.role).toBe('approver');
    expect(p.authVerified).toBe(true);
  });

  it('does not authVerify an approver whose transport was not verified', async () => {
    const p = await resolver.resolve(tgEnvelope('999', false));
    expect(p.role).toBe('approver');
    expect(p.authVerified).toBe(false);
  });

  it('resolves an unknown telegram sender as unknown', async () => {
    const p = await resolver.resolve(tgEnvelope('123', true));
    expect(p.role).toBe('unknown');
    expect(p.authVerified).toBe(false);
  });
});
