import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../../database/types';
import { migrations } from '../../database/migrations';
import { VoucherRepository } from './voucher.repository';
import { VoucherLineRepository } from './voucher-line.repository';
import { AccountService } from '../account/account.service';

describe('VoucherLineRepository (integration)', () => {
  let db: Kysely<Database>;
  let voucherRepo: VoucherRepository;
  let lineRepo: VoucherLineRepository;
  let accounts: AccountService;

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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        VoucherRepository,
        VoucherLineRepository,
        AccountService,
      ],
    }).compile();

    voucherRepo = module.get(VoucherRepository);
    lineRepo = module.get(VoucherLineRepository);
    accounts = module.get(AccountService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('createVoucherLine inserts a line linked to a voucher', async () => {
    const voucher = await voucherRepo.createVoucher({
      voucher_number: 'V-LINE-001',
      tax_point_date: '2026-03-15',
      posted_at: null,
    });
    const cash = await accounts.getAccountByCode('CASH');
    const line = await lineRepo.createVoucherLine({
      voucher_id: voucher.id,
      account_id: cash!.id,
      amount: 10000,
      currency: 'EUR',
      base_amount: 10000,
      fx_rate: 1,
      vat_code: null,
      is_debit: true,
    });
    expect(line.id).toBeGreaterThan(0);
    expect(line.voucher_id).toBe(voucher.id);
    expect(line.is_debit).toBe(true);
  });

  it('getLinesByVoucherId returns all lines for a voucher', async () => {
    const voucher = await voucherRepo.createVoucher({
      voucher_number: 'V-LINE-002',
      tax_point_date: '2026-03-15',
      posted_at: null,
    });
    const expense = await accounts.getAccountByCode('EXPENSE_SOFTWARE');
    const cash = await accounts.getAccountByCode('CASH');
    await lineRepo.createVoucherLine({
      voucher_id: voucher.id,
      account_id: expense!.id,
      amount: 10000,
      currency: 'EUR',
      base_amount: 10000,
      fx_rate: 1,
      vat_code: null,
      is_debit: true,
    });
    await lineRepo.createVoucherLine({
      voucher_id: voucher.id,
      account_id: cash!.id,
      amount: 10000,
      currency: 'EUR',
      base_amount: 10000,
      fx_rate: 1,
      vat_code: null,
      is_debit: false,
    });
    const lines = await lineRepo.getLinesByVoucherId(voucher.id);
    expect(lines).toHaveLength(2);
  });

  it('rejects a line whose voucher_id has no parent voucher (FK, G6)', async () => {
    const cash = await accounts.getAccountByCode('CASH');
    await expect(
      lineRepo.createVoucherLine({
        voucher_id: 999999,
        account_id: cash!.id,
        amount: 10000,
        currency: 'EUR',
        base_amount: 10000,
        fx_rate: 1,
        vat_code: null,
        is_debit: true,
      }),
    ).rejects.toThrow();
  });
});
