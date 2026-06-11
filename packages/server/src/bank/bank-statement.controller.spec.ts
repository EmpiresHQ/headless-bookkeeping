import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { AccountService } from '../ledger/account/account.service';
import { BankStatementService } from './bank-statement.service';
import { BankTransactionRepository } from './bank-transaction.repository';
import { BankStatementController } from './bank-statement.controller';

describe('BankStatementController (integration)', () => {
  let controller: BankStatementController;
  let db: Kysely<Database>;

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
      controllers: [BankStatementController],
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        AccountService,
        BankTransactionRepository,
        BankStatementService,
      ],
    }).compile();

    controller = module.get(BankStatementController);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('POST /api/bank-statements returns 201 with statement + transactions', async () => {
    const result = await controller.createStatement({
      account_code: 'BANK_EUR',
      start_date: '2025-06-01',
      end_date: '2025-06-30',
      transactions: [
        {
          transaction_date: '2025-06-15',
          amount: 10000,
          currency: 'EUR',
        },
      ],
    });

    expect(result.statement.id).toBeDefined();
    expect(result.transactions).toHaveLength(1);
  });

  it('GET /api/bank-statements returns array', async () => {
    // Create a statement first.
    await controller.createStatement({
      account_code: 'BANK_EUR',
      start_date: '2025-07-01',
      end_date: '2025-07-31',
      transactions: [],
    });

    const statements = await controller.listStatements();
    expect(Array.isArray(statements)).toBe(true);
    expect(statements.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/bank-statements/:id/transactions returns transactions for the statement', async () => {
    const created = await controller.createStatement({
      account_code: 'BANK_EUR',
      start_date: '2025-08-01',
      end_date: '2025-08-31',
      transactions: [
        {
          transaction_date: '2025-08-01',
          amount: 5000,
          currency: 'EUR',
        },
        {
          transaction_date: '2025-08-15',
          amount: -2000,
          currency: 'EUR',
        },
      ],
    });

    const txns = await controller.listTransactions(created.statement.id);
    expect(txns).toHaveLength(2);
  });
});
