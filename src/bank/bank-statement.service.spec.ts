import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { AccountService } from '../ledger/account/account.service';
import { BankStatementService } from './bank-statement.service';
import { BankTransactionRepository } from './bank-transaction.repository';

/**
 * Integration test for the bank statement module.
 * Exercises the REAL DI graph against an in-memory SQLite DB seeded by the
 * real migrations (including account seeding).
 */
describe('BankStatementService (integration)', () => {
  let db: Kysely<Database>;
  let service: BankStatementService;

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
        AccountService,
        BankTransactionRepository,
        BankStatementService,
      ],
    }).compile();

    service = module.get(BankStatementService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('creates a statement with BANK_EUR account + 2 transactions → returns statement with id and 2 transactions', async () => {
    const result = await service.createStatement({
      account_code: 'BANK_EUR',
      start_date: '2025-01-01',
      end_date: '2025-01-31',
      transactions: [
        {
          transaction_date: '2025-01-05',
          description: 'Salary deposit',
          amount: 500000,
          currency: 'EUR',
        },
        {
          transaction_date: '2025-01-10',
          description: 'Office rent',
          amount: -120000,
          currency: 'EUR',
        },
      ],
    });

    expect(result.statement.id).toBeDefined();
    expect(result.statement.account_id).toBeDefined();
    expect(result.transactions).toHaveLength(2);
  });

  it('listTransactions returns exactly those rows with correct amounts (including negative)', async () => {
    const { statement } = await service.createStatement({
      account_code: 'BANK_EUR',
      start_date: '2025-02-01',
      end_date: '2025-02-28',
      transactions: [
        {
          transaction_date: '2025-02-01',
          description: 'Incoming',
          amount: 300000,
          currency: 'EUR',
        },
        {
          transaction_date: '2025-02-15',
          description: 'Outgoing',
          amount: -75000,
          currency: 'EUR',
        },
      ],
    });

    const txns = await service.listTransactions(statement.id);
    expect(txns).toHaveLength(2);

    const amounts = txns.map((t) => t.amount).sort((a, b) => a - b);
    expect(amounts).toEqual([-75000, 300000]);
  });

  it('G6 constraint — inserting bank_transaction with status="bogus" is rejected by DB CHECK', async () => {
    const { statement } = await service.createStatement({
      account_code: 'BANK_EUR',
      start_date: '2025-03-01',
      end_date: '2025-03-31',
      transactions: [
        {
          transaction_date: '2025-03-01',
          amount: 10000,
          currency: 'EUR',
        },
      ],
    });

    // Directly insert a row with an invalid status via raw SQL to prove the CHECK.
    await expect(
      db
        .insertInto('bank_transaction')
        .values({
          statement_id: statement.id,
          transaction_date: '2025-03-02',
          amount: 5000,
          currency: 'EUR',
          status: 'bogus',
          created_at: Math.floor(Date.now() / 1000),
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('G6 FK — inserting bank_statement with non-existent account_id is rejected', async () => {
    // SQLite requires PRAGMA foreign_keys = ON to enforce FKs.
    await db.executeQuery(sql`PRAGMA foreign_keys = ON`.compile(db));

    await expect(
      db
        .insertInto('bank_statement')
        .values({
          account_id: 99999,
          start_date: '2025-04-01',
          end_date: '2025-04-30',
          uploaded_at: Math.floor(Date.now() / 1000),
          file_path: null,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('rejects a non-existent account code', async () => {
    await expect(
      service.createStatement({
        account_code: 'BANK_GHOST',
        start_date: '2025-06-01',
        end_date: '2025-06-30',
        transactions: [],
      }),
    ).rejects.toThrow("Account 'BANK_GHOST' not found");
  });

  it('rejects an existing account that is not a bank account (wrong type)', async () => {
    await expect(
      service.createStatement({
        account_code: 'EXPENSE_SOFTWARE',
        start_date: '2025-06-01',
        end_date: '2025-06-30',
        transactions: [],
      }),
    ).rejects.toThrow("Account 'EXPENSE_SOFTWARE' is not a bank account");
  });

  it('G3 discriminating — negative amount round-trips as -1525, currency="USD" round-trips', async () => {
    const result = await service.createStatement({
      account_code: 'BANK_USD',
      start_date: '2025-05-01',
      end_date: '2025-05-31',
      transactions: [
        {
          transaction_date: '2025-05-10',
          description: 'Card purchase',
          amount: -1525,
          currency: 'USD',
          source_currency: 'EUR',
          source_amount: -1400,
          fx_rate: 1.089,
        },
      ],
    });

    const txns = await service.listTransactions(result.statement.id);
    expect(txns).toHaveLength(1);
    expect(txns[0].amount).toBe(-1525);
    expect(txns[0].currency).toBe('USD');
    expect(txns[0].source_currency).toBe('EUR');
    expect(txns[0].source_amount).toBe(-1400);
    expect(txns[0].fx_rate).toBeCloseTo(1.089, 3);
  });

  it('deleteStatement removes the statement and its transactions', async () => {
    const { statement } = await service.createStatement({
      account_code: 'BANK_EUR',
      start_date: '2025-07-01',
      end_date: '2025-07-31',
      transactions: [
        { transaction_date: '2025-07-05', amount: 1000, currency: 'EUR' },
        { transaction_date: '2025-07-06', amount: -500, currency: 'EUR' },
      ],
    });

    await service.deleteStatement(statement.id);

    const statements = await service.listStatements();
    expect(statements.find((s) => s.id === statement.id)).toBeUndefined();
    expect(await service.listTransactions(statement.id)).toHaveLength(0);
  });

  it('deleteStatement throws NotFound for a missing statement', async () => {
    await expect(service.deleteStatement(99999)).rejects.toThrow(
      'Bank statement 99999 not found',
    );
  });
});
