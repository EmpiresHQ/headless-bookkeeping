import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { createHash } from 'node:crypto';
import { Database } from '../database/types';
import { AccountService } from '../ledger/account/account.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import {
  BankTransactionRepository,
  sourceFactsJson,
} from './bank-transaction.repository';
import {
  BankStatementRecord,
  BankTransactionWithSources,
  CreateStatementInput,
  CreateTransactionInput,
  ImportSummary,
} from './bank-statement.types';

/**
 * The canonical bank-transaction journal (issue #399).
 *
 * A statement is an IMPORT ARTIFACT, not the owner of a private copy of
 * every movement it contains. Overlapping statements are a normal, supported
 * workflow: imports accumulate into one canonical journal per account,
 * deduplicating across sources.
 *
 * Two separate identities govern deduplication, never conflated:
 *
 * - MOVEMENT identity — (provider, source account reference, the bank's own
 *   transaction id), all three required. This is authoritative: the same
 *   movement imported through another statement is recognised as
 *   already-known. Any unknown component means the identity is unknown, and
 *   unknown identity NEVER merges — date+amount alone is not identity, and a
 *   NULL provider or source account never merges across statements.
 * - SOURCE-REPLAY identity — the exact same import arriving again (a retry,
 *   a repeat upload, a renamed file, a reordered file). Recognised by a
 *   content hash over the normalized, sorted row multiset, enforced UNIQUE
 *   at storage level. This keeps a re-uploaded identity-less file from
 *   duplicating its own rows while an independent, merely overlapping file
 *   from the same bank stays a distinct source (its shared rows need strong
 *   ids or human review, never a guessed merge).
 *
 * Same authoritative identity + conflicting money facts (amount or currency)
 * → a PERSISTED conflict for review; the canonical row is never overwritten.
 * Same identity + differing non-money facts (a pending→booked date shift, a
 * reworded description) → already-known, with the differing per-source facts
 * retained verbatim on the provenance row; no universal pending/booked
 * equivalence is invented.
 *
 * An identity-less row that exactly matches (account, date, amount,
 * currency) of a row from a DIFFERENT source is inserted as its own movement
 * (multiplicity of genuine identical purchases is preserved) and flagged
 * `ambiguous_overlap` for review.
 */
@Injectable()
export class BankStatementService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly accountService: AccountService,
    private readonly transactionRepo: BankTransactionRepository,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Import a bank statement into the canonical journal. Returns the statement,
   * the canonical transactions it (co-)evidences, and the new/known/conflict
   * summary.
   */
  async createStatement(input: CreateStatementInput): Promise<{
    statement: BankStatementRecord;
    transactions: BankTransactionWithSources[];
    summary: ImportSummary;
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

    const providerCode = input.provider_code
      ? input.provider_code.trim().toUpperCase()
      : null;
    const sourceAccountRef = input.source_account_ref
      ? input.source_account_ref.trim().toUpperCase()
      : null;
    // The source-replay hash (issue #399). Replay is claimed only on
    // AUTHORITATIVE evidence, never inferred from the projected rows alone:
    //
    // - With an explicit RAW-SOURCE FINGERPRINT (the ingestion path computes
    //   it from the ORIGINAL buffer's full raw rows, mapped columns or not,
    //   byte-preserved): it alone identifies the source within this ledger
    //   account, independent of fresh mapping inference. Exports differing in
    //   an unmapped memo are DIFFERENT sources, never one invented replay.
    // - With NO raw-source artifact at all (a pure structured import, no
    //   `file_path`): the caller's identical projected content IS the whole
    //   evidence there is — an exact structured repeat is idempotent by its
    //   own identical content, and a caller importing genuinely different
    //   sources gives them different content or distinct fingerprints.
    // - With a raw-source ARCHIVE (`file_path`) but NO fingerprint: the
    //   caller has raw evidence it did not characterise — UNCERTAIN. No
    //   replay is claimed; every row is decided by its (strong or unknown)
    //   movement identity, and an identity-less twin overlap is flagged for
    //   review rather than collapsed.
    const hasRawArchive = (input.file_path ?? null) !== null;
    const replayClaimable = input.source_fingerprint ? true : !hasRawArchive;
    const contentHash = replayClaimable
      ? this.contentHash(
          account.id,
          providerCode,
          sourceAccountRef,
          input.source_fingerprint ?? null,
          input.transactions,
        )
      : null;

    const uploadedAt = Math.floor(Date.now() / 1000);

    const result = await this.db
      .transaction()
      .execute<
        | { statementId: number; replay: true }
        | { statementId: number; replay: false; summary: ImportSummary }
      >(async (trx) => {
        // Source-replay detection: the exact same import (renamed/reordered)
        // resolves to the ALREADY-IMPORTED statement — nothing is inserted.
        // The UNIQUE(content_hash) index is the storage-level backstop for a
        // concurrent duplicate upload; the read here is the fast path. Only an
        // import with AUTHORITATIVE replay evidence participates (see above).
        const replayed = contentHash
          ? await trx
              .selectFrom('bank_statement')
              .selectAll()
              .where('content_hash', '=', contentHash)
              .executeTakeFirst()
          : undefined;
        if (replayed) {
          return { statementId: replayed.id, replay: true };
        }

        let statementId: number;
        try {
          const row = await trx
            .insertInto('bank_statement')
            .values({
              account_id: account.id,
              start_date: input.start_date,
              end_date: input.end_date,
              uploaded_at: uploadedAt,
              file_path: input.file_path ?? null,
              provider_code: providerCode,
              source_account_ref: sourceAccountRef,
              content_hash: contentHash,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          statementId = row.id;
        } catch (e) {
          if (!contentHash) throw e;
          // Lost the storage-level replay race → the winner's statement IS this
          // import's statement.
          const winner = await trx
            .selectFrom('bank_statement')
            .select('id')
            .where('content_hash', '=', contentHash)
            .executeTakeFirstOrThrow();
          return { statementId: winner.id, replay: true };
        }

        const summary: ImportSummary = {
          newCount: 0,
          newTransactionIds: [],
          knownCount: 0,
          knownTransactionIds: [],
          conflictCount: 0,
          conflicts: [],
        };

        // Weak-evidence ambiguity scan targets: canonical rows of OTHER
        // statements on this account (a same-file repeat is genuine multiplicity).
        for (const [index, t] of input.transactions.entries()) {
          const rowNumber = index + 1;
          const externalId = t.external_id ? t.external_id.trim() : null;

          // ── Authoritative movement identity ──────────────────────────
          if (externalId && providerCode && sourceAccountRef) {
            const existing = await this.transactionRepo.findByIdentity(
              providerCode,
              sourceAccountRef,
              externalId,
              trx,
            );
            if (existing) {
              const conflictKind = this.materialFactConflict(existing, t);
              if (conflictKind) {
                // Conflicting money/settlement facts for the same authoritative
                // identity: persisted for review; the canonical row is NEVER
                // overwritten and its valuation stays spendable only because it
                // is the one reconciled fact (issue #399 + #403 facts).
                const kind = conflictKind;
                const detail = {
                  canonical: {
                    transaction_id: existing.id,
                    transaction_date: existing.transaction_date,
                    booking_date: existing.booking_date,
                    amount: existing.amount,
                    currency: existing.currency,
                    source_amount: existing.source_amount,
                    source_currency: existing.source_currency,
                    fx_rate: existing.fx_rate,
                    conversion_fee: existing.conversion_fee,
                    counterparty_iban: existing.counterparty_iban,
                  },
                  incoming: {
                    statement_row: rowNumber,
                    transaction_date: t.transaction_date,
                    booking_date: t.booking_date ?? null,
                    amount: t.amount,
                    currency: t.currency,
                    source_amount: t.source_amount ?? null,
                    source_currency: t.source_currency ?? null,
                    fx_rate: t.fx_rate ?? null,
                    conversion_fee: t.conversion_fee ?? null,
                    counterparty_iban: t.counterparty_iban ?? null,
                  },
                };
                const inserted = await trx
                  .insertInto('bank_import_conflict')
                  .values({
                    account_id: account.id,
                    provider_code: providerCode,
                    source_account_ref: sourceAccountRef,
                    external_id: externalId,
                    canonical_transaction_id: existing.id,
                    statement_id: statementId,
                    source_row_number: rowNumber,
                    kind,
                    detail: JSON.stringify(detail),
                    status: 'open',
                    created_at: uploadedAt,
                  })
                  .returningAll()
                  .executeTakeFirstOrThrow();
                summary.conflictCount += 1;
                summary.conflicts.push({
                  id: inserted.id,
                  account_id: inserted.account_id,
                  provider_code: inserted.provider_code,
                  source_account_ref: inserted.source_account_ref,
                  external_id: inserted.external_id,
                  canonical_transaction_id: inserted.canonical_transaction_id,
                  statement_id: inserted.statement_id,
                  source_row_number: inserted.source_row_number,
                  kind,
                  detail,
                  status: 'open',
                  created_at: inserted.created_at,
                });
                continue;
              }
              // Same identity, same money facts — already-known. Differing
              // non-money facts (pending/booked dates, wording) are retained
              // verbatim on THIS provenance row; the canonical row keeps its
              // own facts and is never overwritten.
              await this.transactionRepo.insertSource(
                {
                  bankTransactionId: existing.id,
                  statementId,
                  sourceRowNumber: rowNumber,
                  externalId,
                  archiveRef: t.archive_ref ?? null,
                  factsJson: sourceFactsJson(t),
                },
                trx,
              );
              summary.knownCount += 1;
              summary.knownTransactionIds.push(existing.id);
              continue;
            }
          }

          // ── New canonical row (weak identity included) ────────────────
          let created;
          try {
            created = await this.transactionRepo.insertCanonical(
              {
                statementId,
                accountId: account.id,
                providerCode,
                sourceAccountRef,
                transaction: t,
              },
              trx,
            );
          } catch (e) {
            // Lost the storage-level canonical-identity race (concurrent import
            // of the same movement): re-resolve and record provenance instead.
            if (!externalId || !providerCode || !sourceAccountRef) throw e;
            const winner = await this.transactionRepo.findByIdentity(
              providerCode,
              sourceAccountRef,
              externalId,
              trx,
            );
            if (!winner) throw e;
            await this.transactionRepo.insertSource(
              {
                bankTransactionId: winner.id,
                statementId,
                sourceRowNumber: rowNumber,
                externalId,
                archiveRef: t.archive_ref ?? null,
                factsJson: sourceFactsJson(t),
              },
              trx,
            );
            summary.knownCount += 1;
            summary.knownTransactionIds.push(winner.id);
            continue;
          }
          await this.transactionRepo.insertSource(
            {
              bankTransactionId: created.id,
              statementId,
              sourceRowNumber: rowNumber,
              externalId,
              archiveRef: t.archive_ref ?? null,
              factsJson: sourceFactsJson(t),
            },
            trx,
          );
          summary.newCount += 1;
          summary.newTransactionIds.push(created.id);

          // ── Weak-evidence ambiguity, surfaced never guessed ───────────
          // The row carries no authoritative identity, and an EXACT
          // (account, date, amount, currency) twin exists on ANOTHER statement:
          // both movements stand (genuine identical purchases keep their
          // multiplicity), and the overlap is flagged for human review.
          if (!externalId) {
            const twin = await trx
              .selectFrom('bank_transaction')
              .select(['id', 'statement_id'])
              .where('account_id', '=', account.id)
              .where('transaction_date', '=', t.transaction_date)
              .where('amount', '=', t.amount)
              .where('currency', '=', t.currency)
              .where('statement_id', '!=', statementId)
              .executeTakeFirst();
            if (twin) {
              const detail = {
                canonical: {
                  transaction_id: twin.id,
                  statement_id: twin.statement_id,
                  transaction_date: t.transaction_date,
                  amount: t.amount,
                  currency: t.currency,
                },
                incoming: {
                  statement_row: rowNumber,
                  statement_id: statementId,
                  transaction_date: t.transaction_date,
                  amount: t.amount,
                  currency: t.currency,
                },
                note: 'No bank transaction id on either row; identity is unknown. Both movements are retained; review whether they are the same operation.',
              };
              const inserted = await trx
                .insertInto('bank_import_conflict')
                .values({
                  account_id: account.id,
                  provider_code: providerCode,
                  source_account_ref: sourceAccountRef,
                  external_id: `weak:${statementId}:${rowNumber}`,
                  canonical_transaction_id: twin.id,
                  statement_id: statementId,
                  source_row_number: rowNumber,
                  kind: 'ambiguous_overlap',
                  detail: JSON.stringify(detail),
                  status: 'open',
                  created_at: uploadedAt,
                })
                .returningAll()
                .executeTakeFirstOrThrow();
              summary.conflictCount += 1;
              summary.conflicts.push({
                id: inserted.id,
                account_id: inserted.account_id,
                provider_code: inserted.provider_code,
                source_account_ref: inserted.source_account_ref,
                external_id: inserted.external_id,
                canonical_transaction_id: inserted.canonical_transaction_id,
                statement_id: inserted.statement_id,
                source_row_number: inserted.source_row_number,
                kind: 'ambiguous_overlap',
                detail,
                status: 'open',
                created_at: inserted.created_at,
              });
            }
          }
        }

        return { statementId, replay: false, summary };
      });

    const statementRecord = await this.getStatementRecord(result.statementId);
    const transactions = await this.transactionRepo.findByStatementId(
      result.statementId,
    );

    let summary: ImportSummary;
    if (result.replay) {
      // A replayed source is the SAME import request re-arriving: nothing is
      // inserted, and the summary must stay TRUTHFUL about what the ORIGINAL
      // import did (issue #399). Rows that resolved to a canonical movement
      // are known; rows the original import REJECTED as conflicts are still
      // unresolved conflicts — a retry must never relabel a rejected row as
      // successfully known.
      const replaySources = await this.db
        .selectFrom('bank_transaction_source')
        .select('bank_transaction_id')
        .where('statement_id', '=', result.statementId)
        .execute();
      const replayConflicts = await this.db
        .selectFrom('bank_import_conflict')
        .selectAll()
        .where('statement_id', '=', result.statementId)
        .where('status', '=', 'open')
        .execute();
      summary = {
        newCount: 0,
        newTransactionIds: [],
        knownCount: replaySources.length,
        knownTransactionIds: replaySources.map((s) => s.bank_transaction_id),
        conflictCount: replayConflicts.length,
        conflicts: replayConflicts.map((c) => ({
          id: c.id,
          account_id: c.account_id,
          provider_code: c.provider_code,
          source_account_ref: c.source_account_ref,
          external_id: c.external_id,
          canonical_transaction_id: c.canonical_transaction_id,
          statement_id: c.statement_id,
          source_row_number: c.source_row_number,
          kind: c.kind as ImportSummary['conflicts'][number]['kind'],
          detail: JSON.parse(c.detail),
          status: c.status as 'open' | 'resolved',
          created_at: c.created_at,
        })),
      };
    } else {
      summary = result.summary;
    }

    await this.auditLog.record({
      actor: 'system',
      action: 'bank.import',
      outcome: 'accepted',
      target_type: 'bank_statement',
      target_id: result.statementId,
      detail: {
        replay: result.replay,
        provider_code: providerCode,
        source_account_ref: sourceAccountRef,
        new: summary.newCount,
        known: summary.knownCount,
        conflicts: summary.conflictCount,
        conflict_ids: summary.conflicts.map((c) => c.id),
      },
    });

    return { statement: statementRecord, transactions, summary };
  }

  /**
   * Raw-source replay depends only on the source fingerprint and ledger
   * account, never on a fresh LLM mapping of that same source. Structured
   * imports instead hash their complete normalized row multiset and scope.
   * Filename and row order do not participate; multiplicity does.
   */
  private contentHash(
    accountId: number,
    providerCode: string | null,
    sourceAccountRef: string | null,
    sourceFingerprint: string | null,
    transactions: CreateTransactionInput[],
  ): string {
    if (sourceFingerprint) {
      return createHash('sha256')
        .update(
          JSON.stringify({
            account_id: accountId,
            source_fingerprint: sourceFingerprint,
          }),
        )
        .digest('hex');
    }
    const rows = transactions
      .map((t) => ({
        transaction_date: t.transaction_date,
        amount: t.amount,
        currency: t.currency,
        description: t.description ?? null,
        reference: t.reference ?? null,
        counterparty_iban: t.counterparty_iban ?? null,
        counterparty_descriptor: t.counterparty_descriptor ?? null,
        external_id: t.external_id ? t.external_id.trim() : null,
        archive_ref: t.archive_ref ? t.archive_ref.trim() : null,
        source_currency: t.source_currency ?? null,
        source_amount: t.source_amount ?? null,
        fx_rate: t.fx_rate ?? null,
        conversion_fee: t.conversion_fee ?? null,
        booking_date: t.booking_date ?? null,
        bank_reference_rate: t.bank_reference_rate ?? null,
        status: t.status ?? null,
      }))
      .sort((a, b) =>
        JSON.stringify(a) < JSON.stringify(b)
          ? -1
          : JSON.stringify(a) > JSON.stringify(b)
            ? 1
            : 0,
      );
    return createHash('sha256')
      .update(
        JSON.stringify({
          account_id: accountId,
          provider_code: providerCode,
          source_account_ref: sourceAccountRef,
          source_fingerprint: sourceFingerprint,
          rows,
        }),
      )
      .digest('hex');
  }

  /** List all bank statements. */
  async listStatements(): Promise<BankStatementRecord[]> {
    const rows = await this.db
      .selectFrom('bank_statement')
      .selectAll()
      .orderBy('id', 'desc')
      .execute();
    return rows.map((r) => this.mapStatement(r));
  }

  /** List the canonical transactions a statement (co-)evidences, with all
   *  their source provenance (issue #399). */
  async listTransactions(
    statementId: number,
  ): Promise<BankTransactionWithSources[]> {
    return this.transactionRepo.findByStatementId(statementId);
  }

  /** Open (or resolved) import conflicts for review (issue #399). */
  async listConflicts(status: 'open' | 'resolved' = 'open') {
    return this.transactionRepo.listConflicts(status);
  }

  /** Mark an import conflict resolved (a human disposed of it). */
  async resolveConflict(id: number): Promise<void> {
    const updated = await this.db
      .updateTable('bank_import_conflict')
      .set({ status: 'resolved' })
      .where('id', '=', id)
      .where('status', '=', 'open')
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) {
      const existing = await this.db
        .selectFrom('bank_import_conflict')
        .select('id')
        .where('id', '=', id)
        .executeTakeFirst();
      if (!existing) {
        throw new NotFoundException(`Import conflict ${id} not found`);
      }
      // Already resolved — an idempotent re-resolution is a no-op.
      return;
    }
    await this.auditLog.record({
      actor: 'operator',
      action: 'bank.import.conflict.resolve',
      outcome: 'accepted',
      target_type: 'bank_import_conflict',
      target_id: id,
    });
  }

  /**
   * Detach (delete) a statement — an IMPORT artifact, never the owner of the
   * canonical movements it references (issue #399):
   *
   * - a canonical transaction referenced by ANOTHER statement survives
   *   untouched, with all its reconciliation history;
   * - a canonical transaction referenced ONLY here and carrying FINANCIAL
   *   history (matches, settlement claims, advance funding) is RETAINED,
   *   not deleted — silently deleting financial history is forbidden;
   * - only a movement referenced solely here with no financial history is
   *   removed with the statement.
   * Throws 404 if the statement does not exist. This only removes the
   * ingested bank record; it never touches the ledger (ADR-0001).
   */
  async deleteStatement(id: number): Promise<{
    deleted: number;
    retainedTransactionIds: number[];
  }> {
    return this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom('bank_statement')
        .select('id')
        .where('id', '=', id)
        .executeTakeFirst();
      if (!existing) {
        throw new NotFoundException(`Bank statement ${id} not found`);
      }

      const sources = await trx
        .selectFrom('bank_transaction_source')
        .select('bank_transaction_id')
        .where('statement_id', '=', id)
        .execute();
      const txnIds = [...new Set(sources.map((s) => s.bank_transaction_id))];

      await trx
        .deleteFrom('bank_transaction_source')
        .where('statement_id', '=', id)
        .execute();

      // Remove this source's unresolved reviews before considering orphan
      // movements. Resolved reviews remain durable history with the source id.
      await trx
        .deleteFrom('bank_import_conflict')
        .where('statement_id', '=', id)
        .where('status', '=', 'open')
        .execute();

      const retained: number[] = [];
      for (const txnId of txnIds) {
        const others = await this.transactionRepo.countOtherSources(
          id,
          txnId,
          trx,
        );
        if (others > 0) {
          retained.push(txnId);
        } else {
          const financial = await this.transactionRepo.hasFinancialReferences(
            txnId,
            trx,
          );
          // Review and repair history also keep their canonical target
          // resolvable after its last source is detached.
          const conflict = await trx
            .selectFrom('bank_import_conflict')
            .select('id')
            .where('canonical_transaction_id', '=', txnId)
            .executeTakeFirst();
          const repair = await trx
            .selectFrom('bank_duplicate_repair')
            .select('id')
            .where('survivor_id', '=', txnId)
            .executeTakeFirst();
          if (financial || conflict || repair) {
            retained.push(txnId);
          } else {
            await trx
              .deleteFrom('bank_transaction')
              .where('id', '=', txnId)
              .execute();
            continue;
          }
        }
        // Retained: the movement survives this statement's removal. Its
        // ORIGIN statement pointer — if it pointed at the detached
        // statement — becomes NULL (origin detached), never a cascade
        // delete of the canonical row; its provenance, matches and other
        // financial history stay untouched.
        await trx
          .updateTable('bank_transaction')
          .set({ statement_id: null })
          .where('id', '=', txnId)
          .where('statement_id', '=', id)
          .execute();
      }

      await trx.deleteFrom('bank_statement').where('id', '=', id).execute();

      await this.auditLog.record(
        {
          actor: 'operator',
          action: 'bank.statement.delete',
          outcome: 'accepted',
          target_type: 'bank_statement',
          target_id: id,
          detail: { retained_transaction_ids: retained },
        },
        trx,
      );

      return { deleted: id, retainedTransactionIds: retained };
    });
  }

  /**
   * Same authoritative identity, material-fact comparison (issue #399,
   * carrying the #403 settlement facts). Returns the conflict kind, or null
   * when the incoming row is the SAME movement and may be recorded as
   * already-known provenance.
   *
   * Material facts — a difference is a CONFLICT for review, never a silent
   * merge or an overwrite:
   *   - amount / currency (the settled money);
   *   - source_amount / source_currency / fx_rate / conversion_fee (the #403
   *     settlement valuation evidence: DKK 60.00 vs 24.50 under one external
   *     id are different valuations of different purchases);
   *   - counterparty_iban (a supplier-identity fact);
   *   - the dates, UNLESS the difference is exactly the documented
   *     pending/booked alias: each row's {transaction_date, booking_date}
   *     pair must overlap — the value date one source prints is the booking
   *     date the other prints. Any other date change is material.
   *
   * NON-material differences (description wording, counterparty descriptor,
   * reference, archive reference) are retained verbatim on the incoming
   * provenance row — never silently applied to the canonical row, never a
   * conflict.
   */
  private materialFactConflict(
    canonical: {
      transaction_date: string;
      booking_date: string | null;
      amount: number;
      currency: string;
      source_amount: number | null;
      source_currency: string | null;
      fx_rate: number | null;
      conversion_fee: number | null;
      counterparty_iban: string | null;
    },
    incoming: CreateTransactionInput,
  ): 'amount_mismatch' | 'currency_mismatch' | 'fact_mismatch' | null {
    if (canonical.amount !== incoming.amount) return 'amount_mismatch';
    if (canonical.currency !== incoming.currency) return 'currency_mismatch';
    if (
      canonical.source_amount !== (incoming.source_amount ?? null) ||
      canonical.source_currency !== (incoming.source_currency ?? null) ||
      canonical.fx_rate !== (incoming.fx_rate ?? null) ||
      canonical.conversion_fee !== (incoming.conversion_fee ?? null) ||
      canonical.counterparty_iban !== (incoming.counterparty_iban ?? null)
    ) {
      return 'fact_mismatch';
    }
    // The pending/booked date alias: the two dates each row carries must
    // overlap (one source's value date is the other's booking date).
    const canonDates = new Set(
      [canonical.transaction_date, canonical.booking_date].filter(
        (d): d is string => d !== null,
      ),
    );
    const inDates = [incoming.transaction_date, incoming.booking_date].filter(
      (d): d is string => typeof d === 'string' && d !== null,
    );
    const explained = inDates.some((d) => canonDates.has(d));
    if (!explained) return 'fact_mismatch';
    return null;
  }

  private async getStatementRecord(id: number): Promise<BankStatementRecord> {
    const row = await this.db
      .selectFrom('bank_statement')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return this.mapStatement(row);
  }

  private mapStatement(row: {
    id: number;
    account_id: number;
    start_date: string;
    end_date: string;
    uploaded_at: number;
    file_path: string | null;
    provider_code: string | null;
    source_account_ref: string | null;
    content_hash: string | null;
  }): BankStatementRecord {
    const { id, account_id, start_date, end_date, uploaded_at, file_path } =
      row;
    return {
      id,
      account_id,
      start_date,
      end_date,
      uploaded_at,
      file_path,
      provider_code: row.provider_code,
      source_account_ref: row.source_account_ref,
    };
  }
}
