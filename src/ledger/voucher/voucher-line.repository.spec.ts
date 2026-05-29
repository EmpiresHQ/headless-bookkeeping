import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../../database/types';
import { migrations } from '../../database/migrations';
import { VoucherLineRepository } from './voucher-line.repository';
import { AccountService } from '../account/account.service';

describe('VoucherLineRepository (integration)', () => {
  let db: Kysely<Database>;
  let lineRepo: VoucherLineRepository;
  let accounts: AccountService;

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
        VoucherLineRepository,
        AccountService,
      ],
    }).compile();

    lineRepo = module.get(VoucherLineRepository);
    accounts = module.get(AccountService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function seedVoucher(number: string): Promise<number> {
    const v = await db
      .insertInto('voucher')
      .values({ voucher_number: number, tax_point_date: '2026-03-15', posted_at: null })
      .returningAll()
      .executeTakeFirstOrThrow();
    return v.id;
  }

  it('getLinesByVoucherId returns all lines for a voucher', async () => {
    const voucherId = await seedVoucher('V-LINE-002');
    const expense = await accounts.getAccountByCode('EXPENSE_SOFTWARE');
    const cash = await accounts.getAccountByCode('CASH');
    await db.insertInto('voucher_line').values([
      { voucher_id: voucherId, account_id: expense!.id, amount: 10000, currency: 'EUR', base_amount: 10000, fx_rate: 1, vat_code: null, is_debit: 1 },
      { voucher_id: voucherId, account_id: cash!.id, amount: 10000, currency: 'EUR', base_amount: 10000, fx_rate: 1, vat_code: null, is_debit: 0 },
    ]).execute();
    const lines = await lineRepo.getLinesByVoucherId(voucherId);
    expect(lines).toHaveLength(2);
    expect(lines[0].is_debit).toBe(true);
  });

  it('rejects a line whose voucher_id has no parent voucher (FK, G6)', async () => {
    const cash = await accounts.getAccountByCode('CASH');
    await expect(
      db.insertInto('voucher_line').values({
        voucher_id: 999999, account_id: cash!.id, amount: 10000, currency: 'EUR',
        base_amount: 10000, fx_rate: 1, vat_code: null, is_debit: 1,
      }).execute(),
    ).rejects.toThrow();
  });
});
