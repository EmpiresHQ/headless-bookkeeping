import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely, Selectable } from 'kysely';
import { Database, BankTransactionTable } from '../database/types';
import {
  BankTransactionRecord,
  BankTransactionStatus,
  CreateTransactionInput,
} from './bank-statement.types';

@Injectable()
export class BankTransactionRepository {
  constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

  /** Insert multiple transaction rows for a given statement. */
  async insertMany(
    statementId: number,
    transactions: CreateTransactionInput[],
  ): Promise<BankTransactionRecord[]> {
    if (transactions.length === 0) {
      return [];
    }

    const now = Math.floor(Date.now() / 1000);
    await this.db
      .insertInto('bank_transaction')
      .values(
        transactions.map((t) => ({
          statement_id: statementId,
          transaction_date: t.transaction_date,
          description: t.description ?? null,
          amount: t.amount,
          currency: t.currency,
          source_currency: t.source_currency ?? null,
          source_amount: t.source_amount ?? null,
          fx_rate: t.fx_rate ?? null,
          counterparty_iban: t.counterparty_iban ?? null,
          counterparty_descriptor: t.counterparty_descriptor ?? null,
          reference: t.reference ?? null,
          status: t.status ?? 'open',
          created_at: now,
        })),
      )
      .execute();

    // Return the inserted rows (SQLite doesn't return full rows, so re-fetch).
    return this.findByStatementId(statementId);
  }

  /** Find all transactions belonging to a statement. */
  async findByStatementId(
    statementId: number,
  ): Promise<BankTransactionRecord[]> {
    const rows = await this.db
      .selectFrom('bank_transaction')
      .selectAll()
      .where('statement_id', '=', statementId)
      .orderBy('transaction_date')
      .execute();
    return rows.map((row) => this.mapRow(row));
  }

  /** Find a single transaction by id. */
  async findById(id: number): Promise<BankTransactionRecord | null> {
    const row = await this.db
      .selectFrom('bank_transaction')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? this.mapRow(row) : null;
  }

  /** Update the status of a transaction. */
  async updateStatus(id: number, status: BankTransactionStatus): Promise<void> {
    await this.db
      .updateTable('bank_transaction')
      .set({ status })
      .where('id', '=', id)
      .execute();
  }

  /** Find all transactions with a given status. */
  async findByStatus(
    status: BankTransactionStatus,
  ): Promise<BankTransactionRecord[]> {
    const rows = await this.db
      .selectFrom('bank_transaction')
      .selectAll()
      .where('status', '=', status)
      .orderBy('transaction_date')
      .execute();
    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: Selectable<BankTransactionTable>): BankTransactionRecord {
    const {
      id,
      statement_id,
      transaction_date,
      description,
      amount,
      currency,
      source_currency,
      source_amount,
      fx_rate,
      counterparty_iban,
      counterparty_descriptor,
      reference,
      status,
      created_at,
    } = row;
    return {
      id,
      statement_id,
      transaction_date,
      description,
      amount,
      currency,
      source_currency,
      source_amount,
      fx_rate,
      counterparty_iban,
      counterparty_descriptor,
      reference,
      status: status as BankTransactionStatus,
      created_at,
    };
  }
}
