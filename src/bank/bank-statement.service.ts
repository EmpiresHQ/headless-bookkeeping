import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { AccountService } from '../ledger/account/account.service';
import { BankTransactionRepository } from './bank-transaction.repository';
import {
  BankStatementRecord,
  BankTransactionRecord,
  CreateStatementInput,
} from './bank-statement.types';

@Injectable()
export class BankStatementService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly accountService: AccountService,
    private readonly transactionRepo: BankTransactionRepository,
  ) {}

  /**
   * Create a bank statement with its transaction lines.
   * Validates that the account exists and is a real bank account
   * (asset type + BANK_* code prefix) — rejects anything else.
   */
  async createStatement(input: CreateStatementInput): Promise<{
    statement: BankStatementRecord;
    transactions: BankTransactionRecord[];
  }> {
    // Resolve account_code → account record first.
    const account = await this.accountService.getAccountByCode(
      input.account_code,
    );
    if (!account) {
      throw new BadRequestException(
        `Account '${input.account_code}' not found`,
      );
    }

    // Hard validation: must be an asset account whose code starts with BANK_.
    if (account.type !== 'asset' || !account.code.startsWith('BANK_')) {
      throw new BadRequestException(
        `Account '${input.account_code}' is not a bank account`,
      );
    }

    const uploadedAt = Math.floor(Date.now() / 1000);

    // Insert the statement — SQLite RETURNING gives us the row back atomically.
    const row = await this.db
      .insertInto('bank_statement')
      .values({
        account_id: account.id,
        start_date: input.start_date,
        end_date: input.end_date,
        uploaded_at: uploadedAt,
        file_path: input.file_path ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const {
      id,
      account_id,
      start_date,
      end_date,
      uploaded_at,
      file_path,
    } = row;
    const statement: BankStatementRecord = {
      id,
      account_id,
      start_date,
      end_date,
      uploaded_at,
      file_path,
    };

    // Insert transactions.
    const transactions = await this.transactionRepo.insertMany(
      statement.id,
      input.transactions,
    );

    return { statement, transactions };
  }

  /** List all bank statements. */
  async listStatements(): Promise<BankStatementRecord[]> {
    const rows = await this.db
      .selectFrom('bank_statement')
      .selectAll()
      .orderBy('id', 'desc')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      account_id: r.account_id,
      start_date: r.start_date,
      end_date: r.end_date,
      uploaded_at: r.uploaded_at,
      file_path: r.file_path,
    }));
  }

  /** List all transactions for a given statement. */
  async listTransactions(
    statementId: number,
  ): Promise<BankTransactionRecord[]> {
    return this.transactionRepo.findByStatementId(statementId);
  }
}
