import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely, Selectable } from 'kysely';
import { Database, BankTransactionTable } from '../database/types';
import {
  BankTransactionRecord,
  BankTransactionSourceRef,
  BankTransactionStatus,
  BankTransactionWithSources,
  BankImportConflictView,
  CreateTransactionInput,
} from './bank-statement.types';

/** An executor that works both on the connection and inside a transaction. */
export type Dbx = Kysely<Database>;

/** The per-source facts a provenance row retains verbatim (issue #399). */
export function sourceFactsJson(t: CreateTransactionInput): string {
  return JSON.stringify({
    transaction_date: t.transaction_date,
    booking_date: t.booking_date ?? null,
    description: t.description ?? null,
    reference: t.reference ?? null,
    archive_ref: t.archive_ref ?? null,
    source_currency: t.source_currency ?? null,
    source_amount: t.source_amount ?? null,
    fx_rate: t.fx_rate ?? null,
    conversion_fee: t.conversion_fee ?? null,
    bank_reference_rate: t.bank_reference_rate ?? null,
  });
}

@Injectable()
export class BankTransactionRepository {
  constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

  /**
   * Insert one CANONICAL transaction row (issue #399). The caller has already
   * decided the row is new (identity lookup + the storage-level UNIQUE index
   * are the guards, not this method). Returns the inserted row.
   */
  async insertCanonical(
    args: {
      statementId: number;
      accountId: number;
      providerCode: string | null;
      sourceAccountRef: string | null;
      transaction: CreateTransactionInput;
    },
    executor: Dbx = this.db,
  ): Promise<BankTransactionRecord> {
    const t = args.transaction;
    const now = Math.floor(Date.now() / 1000);
    const row = await executor
      .insertInto('bank_transaction')
      .values({
        statement_id: args.statementId,
        account_id: args.accountId,
        provider_code: args.providerCode,
        source_account_ref: args.sourceAccountRef,
        external_id: t.external_id ?? null,
        archive_ref: t.archive_ref ?? null,
        transaction_date: t.transaction_date,
        description: t.description ?? null,
        amount: t.amount,
        currency: t.currency,
        source_currency: t.source_currency ?? null,
        source_amount: t.source_amount ?? null,
        fx_rate: t.fx_rate ?? null,
        conversion_fee: t.conversion_fee ?? null,
        booking_date: t.booking_date ?? null,
        bank_reference_rate: t.bank_reference_rate ?? null,
        fx_rate_decimals: t.fx_rate_decimals ?? null,
        counterparty_iban: t.counterparty_iban ?? null,
        counterparty_descriptor: t.counterparty_descriptor ?? null,
        reference: t.reference ?? null,
        status: t.status ?? 'open',
        created_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.mapRow(row);
  }

  /**
   * Record one imported source row that resolved to a canonical transaction
   * (issue #399 provenance). UNIQUE(statement_id, source_row_number) makes a
   * re-processed row of the same statement collide at storage level.
   */
  async insertSource(
    args: {
      bankTransactionId: number;
      statementId: number;
      sourceRowNumber: number | null;
      externalId: string | null;
      archiveRef: string | null;
      factsJson: string | null;
    },
    executor: Dbx = this.db,
  ): Promise<void> {
    await executor
      .insertInto('bank_transaction_source')
      .values({
        bank_transaction_id: args.bankTransactionId,
        statement_id: args.statementId,
        source_row_number: args.sourceRowNumber,
        external_id: args.externalId,
        archive_ref: args.archiveRef,
        facts: args.factsJson,
        created_at: Math.floor(Date.now() / 1000),
      })
      .execute();
  }

  /**
   * Find the canonical transaction by its full identity (issue #399). Only a
   * COMPLETE identity (provider + source account + external id all known)
   * identifies a movement — this method is never called with a partial one.
   */
  async findByIdentity(
    providerCode: string,
    sourceAccountRef: string,
    externalId: string,
    executor: Dbx = this.db,
  ): Promise<BankTransactionRecord | null> {
    const row = await executor
      .selectFrom('bank_transaction')
      .selectAll()
      .where('provider_code', '=', providerCode)
      .where('source_account_ref', '=', sourceAccountRef)
      .where('external_id', '=', externalId)
      .executeTakeFirst();
    return row ? this.mapRow(row) : null;
  }

  /**
   * Find a single transaction by id, resolving repair aliases (issue #399):
   * a removed duplicate's id resolves to its survivor, so references to the
   * old id keep working instead of 404ing.
   */
  async findById(id: number): Promise<BankTransactionRecord | null> {
    const alias = await this.db
      .selectFrom('bank_transaction_alias')
      .select('canonical_transaction_id')
      .where('alias_transaction_id', '=', id)
      .executeTakeFirst();
    const resolvedId = alias ? alias.canonical_transaction_id : id;
    const row = await this.db
      .selectFrom('bank_transaction')
      .selectAll()
      .where('id', '=', resolvedId)
      .executeTakeFirst();
    return row ? this.mapRow(row) : null;
  }

  /**
   * The transaction's source statement for audit/provenance references
   * (issues #399/#403): its ORIGIN statement when that still exists, else
   * the earliest remaining statement that co-evidences the canonical row
   * (an origin may have been detached while the movement survives). Null
   * only when no source statement remains at all.
   */
  async resolveSourceStatementId(txn: {
    id: number;
    statement_id: number | null;
  }): Promise<number | null> {
    if (txn.statement_id !== null) return txn.statement_id;
    const row = await this.db
      .selectFrom('bank_transaction_source')
      .select('statement_id')
      .where('bank_transaction_id', '=', txn.id)
      .orderBy('statement_id')
      .executeTakeFirst();
    return row ? row.statement_id : null;
  }

  /**
   * Every source row that resolved to a canonical transaction (issue #399).
   */
  async listSources(
    bankTransactionId: number,
    executor: Dbx = this.db,
  ): Promise<BankTransactionSourceRef[]> {
    const rows = await executor
      .selectFrom('bank_transaction_source')
      .select([
        'statement_id',
        'source_row_number',
        'external_id',
        'archive_ref',
        'created_at',
      ])
      .where('bank_transaction_id', '=', bankTransactionId)
      .orderBy('statement_id')
      .execute();
    return rows.map((r) => ({
      statement_id: r.statement_id,
      source_row_number: r.source_row_number,
      external_id: r.external_id,
      archive_ref: r.archive_ref,
      created_at: r.created_at,
    }));
  }

  /**
   * All canonical transactions a statement's source rows resolved to (issue
   * #399) — a statement is an import artifact whose view is the set of
   * canonical movements it (co-)evidences, each with its full provenance.
   */
  async findByStatementId(
    statementId: number,
  ): Promise<BankTransactionWithSources[]> {
    const sourceRows = await this.db
      .selectFrom('bank_transaction_source')
      .innerJoin(
        'bank_transaction',
        'bank_transaction.id',
        'bank_transaction_source.bank_transaction_id',
      )
      .select([
        'bank_transaction_source.statement_id',
        'bank_transaction_source.source_row_number',
        'bank_transaction_source.external_id as src_external_id',
        'bank_transaction_source.archive_ref as src_archive_ref',
        'bank_transaction.id as txn_id',
        'bank_transaction.transaction_date as txn_date',
      ])
      .where('bank_transaction_source.statement_id', '=', statementId)
      .execute();
    // The ORIGIN fallback: a row whose origin statement is this statement
    // but that carries no provenance link (a legacy row whose backfilled
    // provenance was removed with another statement's detach, or a row
    // inserted by a path predating provenance). Both means stay visible.
    const originRows = await this.db
      .selectFrom('bank_transaction')
      .selectAll()
      .where('statement_id', '=', statementId)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('bank_transaction_source')
              .select('id')
              .whereRef(
                'bank_transaction_source.bank_transaction_id',
                '=',
                'bank_transaction.id',
              )
              .where('bank_transaction_source.statement_id', '=', statementId),
          ),
        ),
      )
      .orderBy('transaction_date')
      .orderBy('id')
      .execute();
    const txnIds = [
      ...new Set([
        ...sourceRows.map((r) => r.txn_id),
        ...originRows.map((r) => r.id),
      ]),
    ];
    if (txnIds.length === 0) return [];
    const txnRows = await this.db
      .selectFrom('bank_transaction')
      .selectAll()
      .where('id', 'in', txnIds)
      .orderBy('transaction_date')
      .orderBy('id')
      .execute();
    // The FULL many-source provenance of every canonical row (issue #399):
    // a statement's view shows its own source rows AND the other statements
    // that co-evidence the same movements — visibly shared state.
    const allSources = await this.db
      .selectFrom('bank_transaction_source')
      .select([
        'bank_transaction_id',
        'statement_id',
        'source_row_number',
        'external_id',
        'archive_ref',
        'created_at',
      ])
      .where('bank_transaction_id', 'in', txnIds)
      .orderBy('statement_id')
      .execute();
    const byId = new Map<number, BankTransactionWithSources>();
    for (const row of txnRows) {
      byId.set(row.id, { ...this.mapRow(row), sources: [] });
    }
    for (const s of allSources) {
      const txn = byId.get(s.bank_transaction_id);
      if (!txn) continue;
      txn.sources.push({
        statement_id: s.statement_id,
        source_row_number: s.source_row_number,
        external_id: s.external_id,
        archive_ref: s.archive_ref,
        created_at: s.created_at,
      });
    }
    for (const row of originRows) {
      const txn = byId.get(row.id);
      if (!txn) continue;
      if (!txn.sources.some((src) => src.statement_id === statementId)) {
        txn.sources.push({
          statement_id: statementId,
          source_row_number: null,
          external_id: row.external_id,
          archive_ref: row.archive_ref,
          created_at: row.created_at,
        });
      }
    }
    return [...byId.values()];
  }

  /** Is this canonical transaction evidenced by this statement? (issue #399) */
  async isReferencedByStatement(
    statementId: number,
    bankTransactionId: number,
    executor: Dbx = this.db,
  ): Promise<boolean> {
    const row = await executor
      .selectFrom('bank_transaction_source')
      .select('id')
      .where('statement_id', '=', statementId)
      .where('bank_transaction_id', '=', bankTransactionId)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** How many OTHER statements evidence this canonical transaction? */
  async countOtherSources(
    statementId: number,
    bankTransactionId: number,
    executor: Dbx = this.db,
  ): Promise<number> {
    const row = await executor
      .selectFrom('bank_transaction_source')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('bank_transaction_id', '=', bankTransactionId)
      .where('statement_id', '!=', statementId)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /**
   * Does this transaction carry FINANCIAL history — reconciliation matches
   * (draft or active), a settlement-evidence claim, or an advance funding
   * link (issue #399)? Such a row is never silently deleted by a detach or
   * a duplicate repair.
   */
  async hasFinancialReferences(
    bankTransactionId: number,
    executor: Dbx = this.db,
  ): Promise<boolean> {
    // Dispositions can post bank legs without a reconciliation_match
    // (personal), so their status itself is protected financial history.
    const transaction = await executor
      .selectFrom('bank_transaction')
      .select('status')
      .where('id', '=', bankTransactionId)
      .executeTakeFirst();
    if (transaction && transaction.status !== 'open') return true;
    const match = await executor
      .selectFrom('reconciliation_match')
      .select('id')
      .where('bank_transaction_id', '=', bankTransactionId)
      .where('status', 'in', ['draft', 'active'])
      .executeTakeFirst();
    if (match) return true;
    const usage = await executor
      .selectFrom('bank_settlement_usage')
      .select('bank_transaction_id')
      .where('bank_transaction_id', '=', bankTransactionId)
      .executeTakeFirst();
    if (usage) return true;
    const advance = await executor
      .selectFrom('prepayment_advance')
      .select('id')
      .where('bank_transaction_id', '=', bankTransactionId)
      .executeTakeFirst();
    return advance !== undefined;
  }

  /** Open import conflicts, newest first (issue #399). */
  async listConflicts(
    status: 'open' | 'resolved' = 'open',
  ): Promise<BankImportConflictView[]> {
    const rows = await this.db
      .selectFrom('bank_import_conflict')
      .selectAll()
      .where('status', '=', status)
      .orderBy('id', 'desc')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      account_id: r.account_id,
      provider_code: r.provider_code,
      source_account_ref: r.source_account_ref,
      external_id: r.external_id,
      canonical_transaction_id: r.canonical_transaction_id,
      statement_id: r.statement_id,
      source_row_number: r.source_row_number,
      kind: r.kind as
        | 'amount_mismatch'
        | 'currency_mismatch'
        | 'fact_mismatch'
        | 'ambiguous_overlap',
      detail: JSON.parse(r.detail),
      status: r.status as 'open' | 'resolved',
      created_at: r.created_at,
    }));
  }

  /** Update the status of a transaction. */
  async updateStatus(
    id: number,
    status: BankTransactionStatus,
    executor: Dbx = this.db,
  ): Promise<void> {
    await executor
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
      account_id,
      provider_code,
      source_account_ref,
      external_id,
      archive_ref,
      transaction_date,
      description,
      amount,
      currency,
      source_currency,
      source_amount,
      fx_rate,
      conversion_fee,
      booking_date,
      bank_reference_rate,
      fx_rate_decimals,
      counterparty_iban,
      counterparty_descriptor,
      reference,
      status,
      created_at,
    } = row;
    return {
      id,
      statement_id,
      account_id,
      provider_code,
      source_account_ref,
      external_id,
      archive_ref,
      transaction_date,
      description,
      amount,
      currency,
      source_currency,
      source_amount,
      fx_rate,
      conversion_fee,
      booking_date,
      bank_reference_rate,
      fx_rate_decimals,
      counterparty_iban,
      counterparty_descriptor,
      reference,
      status: status as BankTransactionStatus,
      created_at,
    };
  }
}
