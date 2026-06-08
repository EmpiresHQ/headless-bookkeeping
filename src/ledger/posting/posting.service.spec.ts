import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../../database/types';
import { migrations } from '../../database/migrations';
import { AccountService } from '../account/account.service';
import { VoucherRepository } from '../voucher/voucher.repository';
import { VoucherLineRepository } from '../voucher/voucher-line.repository';
import { LedgerValidationService } from '../validation/ledger-validation.service';
import { PostingService } from './posting.service';
import { PeriodLockService } from '../../reporting-periods/period-lock.service';
import { ValidationError } from './types';
import { DraftVoucher } from '../voucher/types';
import { GENESIS_HASH, computeVoucherHash } from './voucher-hash';

describe('PostingService (integration)', () => {
  let db: Kysely<Database>;
  let posting: PostingService;
  let voucherRepo: VoucherRepository;
  let lineRepo: VoucherLineRepository;

  const balanced = (number: string): DraftVoucher => ({
    voucher_number: number,
    tax_point_date: '2026-03-15',
    lines: [
      {
        account_code: 'EXPENSE_SOFTWARE',
        amount: 10000,
        currency: 'EUR',
        base_amount: 10000,
        fx_rate: 1,
        is_debit: true,
      },
      {
        account_code: 'CASH',
        amount: 10000,
        currency: 'EUR',
        base_amount: 10000,
        fx_rate: 1,
        is_debit: false,
      },
    ],
  });

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
        VoucherRepository,
        VoucherLineRepository,
        LedgerValidationService,
        PostingService,
        PeriodLockService,
      ],
    }).compile();

    posting = module.get(PostingService);
    voucherRepo = module.get(VoucherRepository);
    lineRepo = module.get(VoucherLineRepository);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('posts a valid voucher with posted_at set and both lines persisted', async () => {
    const result = await posting.postVoucher(balanced('V-2026-100'));
    expect(result.id).toBeGreaterThan(0);
    expect(result.posted_at).not.toBeNull();
    expect(result.lines).toHaveLength(2);

    const persisted = await lineRepo.getLinesByVoucherId(result.id);
    expect(persisted).toHaveLength(2);
  });

  it('resolves account_code to the correct account_id', async () => {
    const result = await posting.postVoucher(balanced('V-2026-101'));
    const debit = result.lines.find((l) => l.is_debit);
    expect(debit?.account_id).toBeGreaterThan(0);
  });

  it('throws ValidationError and writes NOTHING for an unbalanced voucher', async () => {
    const unbalanced: DraftVoucher = {
      voucher_number: 'V-2026-102',
      tax_point_date: '2026-03-15',
      lines: [
        {
          account_code: 'EXPENSE_SOFTWARE',
          amount: 10000,
          currency: 'EUR',
          base_amount: 10000,
          fx_rate: 1,
          is_debit: true,
        },
        {
          account_code: 'CASH',
          amount: 9900,
          currency: 'EUR',
          base_amount: 9900,
          fx_rate: 1,
          is_debit: false,
        },
      ],
    };
    await expect(posting.postVoucher(unbalanced)).rejects.toThrow(
      ValidationError,
    );
    expect(await voucherRepo.getVouchers()).toHaveLength(0);
  });

  it('throws ValidationError for an unknown account_code and writes nothing', async () => {
    const draft: DraftVoucher = {
      voucher_number: 'V-2026-103',
      tax_point_date: '2026-03-15',
      lines: [
        {
          account_code: 'NOT_A_REAL_ACCOUNT',
          amount: 10000,
          currency: 'EUR',
          base_amount: 10000,
          fx_rate: 1,
          is_debit: true,
        },
        {
          account_code: 'CASH',
          amount: 10000,
          currency: 'EUR',
          base_amount: 10000,
          fx_rate: 1,
          is_debit: false,
        },
      ],
    };
    await expect(posting.postVoucher(draft)).rejects.toThrow(ValidationError);
    expect(await voucherRepo.getVouchers()).toHaveLength(0);
  });

  it('posts an FX voucher balancing on base_amount (non-default values, G3)', async () => {
    const draft: DraftVoucher = {
      voucher_number: 'V-2026-104',
      tax_point_date: '2026-03-15',
      lines: [
        {
          account_code: 'BANK_USD',
          amount: 10000,
          currency: 'USD',
          base_amount: 9200,
          fx_rate: 0.92,
          is_debit: true,
        },
        {
          account_code: 'REVENUE',
          amount: 9200,
          currency: 'EUR',
          base_amount: 9200,
          fx_rate: 1,
          is_debit: false,
        },
      ],
    };
    const result = await posting.postVoucher(draft);
    expect(result.lines).toHaveLength(2);
    const usdLine = result.lines.find((l) => l.currency === 'USD');
    expect(usdLine?.base_amount).toBe(9200);
  });

  it('sets previous_hash to GENESIS_HASH for the first voucher', async () => {
    const result = await posting.postVoucher(balanced('V-2026-200'));
    expect(result.previous_hash).toBe(GENESIS_HASH);
  });

  it('links each voucher to the hash of the prior one', async () => {
    const first = await posting.postVoucher(balanced('V-2026-201'));
    const firstLines = await lineRepo.getLinesByVoucherId(first.id);
    const second = await posting.postVoucher(balanced('V-2026-202'));
    expect(second.previous_hash).toBe(computeVoucherHash(first, firstLines));
  });

  it('rejects a negative-fx_rate voucher that would otherwise "balance" (writes nothing)', async () => {
    const attack: DraftVoucher = {
      voucher_number: 'V-2026-203',
      tax_point_date: '2026-03-15',
      lines: [
        {
          account_code: 'EXPENSE_SOFTWARE',
          amount: 10000,
          currency: 'EUR',
          base_amount: 10000,
          fx_rate: -1,
          is_debit: true,
        },
        {
          account_code: 'CASH',
          amount: 10000,
          currency: 'EUR',
          base_amount: 10000,
          fx_rate: -1,
          is_debit: false,
        },
      ],
    };
    await expect(posting.postVoucher(attack)).rejects.toThrow(ValidationError);
    expect(await voucherRepo.getVouchers()).toHaveLength(0);
  });

  describe('postVouchersAtomic', () => {
    it('posts multiple drafts in one transaction with a chained hash', async () => {
      const [first, second] = await posting.postVouchersAtomic([
        balanced('V-2026-300'),
        balanced('V-2026-301'),
      ]);

      expect(await voucherRepo.getVouchers()).toHaveLength(2);
      expect(first.previous_hash).toBe(GENESIS_HASH);

      const firstLines = await lineRepo.getLinesByVoucherId(first.id);
      expect(second.previous_hash).toBe(computeVoucherHash(first, firstLines));
    });

    it('rejects the whole batch up front if any draft is invalid (preflight)', async () => {
      const invalidSecond: DraftVoucher = {
        voucher_number: 'V-2026-302',
        tax_point_date: '2026-03-15',
        lines: [
          {
            account_code: 'EXPENSE_SOFTWARE',
            amount: 10000,
            currency: 'EUR',
            base_amount: 10000,
            fx_rate: 1,
            is_debit: true,
          },
          {
            account_code: 'CASH',
            amount: 9900, // unbalanced
            currency: 'EUR',
            base_amount: 9900,
            fx_rate: 1,
            is_debit: false,
          },
        ],
      };

      await expect(
        posting.postVouchersAtomic([balanced('V-2026-303'), invalidSecond]),
      ).rejects.toThrow(ValidationError);

      // The first (valid) draft must NOT have been posted.
      expect(await voucherRepo.getVouchers()).toHaveLength(0);
    });

    it('rolls back the first voucher when a later post throws INSIDE the transaction', async () => {
      // Force the second postVoucherTx to fail after the first has already
      // inserted its voucher + sequence row inside the open transaction. The
      // whole transaction must roll back: zero vouchers, sequence not advanced.
      const original = posting.postVoucherTx.bind(posting);
      const spy = jest
        .spyOn(posting, 'postVoucherTx')
        .mockImplementationOnce(original)
        .mockImplementationOnce(() =>
          Promise.reject(new Error('boom inside trx')),
        );

      await expect(
        posting.postVouchersAtomic([
          balanced('V-2026-304'),
          balanced('V-2026-305'),
        ]),
      ).rejects.toThrow('boom inside trx');

      expect(await voucherRepo.getVouchers()).toHaveLength(0);

      const seq = await db.selectFrom('voucher_sequence').selectAll().execute();
      expect(seq.every((s) => s.last_number === 0)).toBe(true);

      spy.mockRestore();
    });
  });
});
