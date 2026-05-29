import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../../database/types';
import { migrations } from '../../database/migrations';
import { AccountService } from './account.service';

describe('AccountService (integration)', () => {
  let db: Kysely<Database>;
  let service: AccountService;

  beforeEach(async () => {
    const rawDb = new SqliteDb(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: rawDb }),
    });

    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error)
      throw error instanceof Error ? error : new Error('Migration failed');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        AccountService,
      ],
    }).compile();

    service = module.get(AccountService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('seeds at least 20 canonical accounts', async () => {
    const accounts = await service.getAccounts();
    expect(accounts.length).toBeGreaterThanOrEqual(20);
  });

  it('seeds the EUR home bank account (BANK_EUR), not BANK_DKK', async () => {
    const codes = (await service.getAccounts()).map((a) => a.code);
    expect(codes).toContain('BANK_EUR');
    expect(codes).not.toContain('BANK_DKK');
  });

  it('seeds canonical accounts across all five types', async () => {
    const codes = (await service.getAccounts()).map((a) => a.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'CASH',
        'BANK_EUR',
        'BANK_USD',
        'AR',
        'AP',
        'VAT_PAYABLE',
        'EQUITY',
        'REVENUE',
        'EXPENSE_SOFTWARE',
        'FX_GAIN_LOSS',
      ]),
    );
    expect(codes).not.toContain('FX_GAIN');
  });

  it('getAccountByCode returns the requested account (non-default lookup)', async () => {
    const account = await service.getAccountByCode('EXPENSE_TRANSPORT');
    expect(account).not.toBeNull();
    expect(account?.code).toBe('EXPENSE_TRANSPORT');
    expect(account?.type).toBe('expense');
  });

  it('getAccountByCode returns null for an unknown code', async () => {
    await expect(
      service.getAccountByCode('NOT_A_REAL_CODE'),
    ).resolves.toBeNull();
  });

  it('marks seeded accounts as system accounts', async () => {
    const cash = await service.getAccountByCode('CASH');
    expect(cash?.is_system).toBe(true);
  });

  it('tracks BANK_USD as a foreign-currency account', async () => {
    const bankUsd = await service.getAccountByCode('BANK_USD');
    expect(bankUsd?.currency).toBe('USD');
  });

  it('leaves base-currency accounts with a null currency', async () => {
    const cash = await service.getAccountByCode('CASH');
    expect(cash?.currency).toBeNull();
  });
});
