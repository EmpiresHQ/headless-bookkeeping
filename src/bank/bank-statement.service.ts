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
   * Validates that the account_code starts with 'BANK_' — rejects others.
   */
  async createStatement(input: CreateStatementInput): Promise<{
    statement: BankStatementRecord;
    transactions: BankTransactionRecord[];
  }> {
    // Validate account code prefix.
    if (!input.account_code.startsWith('BANK_')) {
      throw new BadRequestException(
        `account_code must start with 'BANK_', got '${input.account_code}'`,
      );
    }

    // Resolve account_code → account_id.
    const account = await this.accountService.getAccountByCode(
      input.account_code,
    );
    if (!account) {
      throw new BadRequestException(
        `Account '${input.account_code}' not found`,
      );
    }

    const uploadedAt = Math.floor(Date.now() / 1000);

    // Insert the statement.
    await this.db
      .insertInto('bank_statement')
      .values({
        account_id: account.id,
        start_date: input.start_date,
        end_date: input.end_date,
        uploaded_at: uploadedAt,
        file_path: input.file_path ?? null,
      })
      .execute();

    // SQLite insert doesn't return the id directly; fetch it.
    const statementRow = await this.db
      .selectFrom('bank_statement')
      .selectAll()
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();

    const statement: BankStatementRecord = {
      id: statementRow.id,
      account_id: statementRow.account_id,
      start_date: statementRow.start_date,
      end_date: statementRow.end_date,
      uploaded_at: statementRow.uploaded_at,
      file_path: statementRow.file_path,
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
