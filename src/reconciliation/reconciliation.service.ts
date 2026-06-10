import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely, Transaction } from 'kysely';
import { Database } from '../database/types';
import { BankTransactionRepository } from '../bank/bank-transaction.repository';
import { BankTransactionRecord } from '../bank/bank-statement.types';
import { EntitiesService } from '../entities/entities.service';
import { CurrencyService } from '../currency/currency.service';
import { OutstandingVoucherService } from './outstanding-voucher.service';
import { FXRealizedService, FXRealizedResult } from './fx-realized.service';
import {
  MatchProposal,
  MatchProposalView,
  MatchObjectType,
  MatchType,
  MatchConfidence,
  ReconciliationMatchRecord,
  ReconciliationStatusRow,
  ExecuteMatchResult,
  ParsedTransactionTokens,
  CandidateVoucher,
} from './reconciliation.types';

/** Regex patterns for deterministic token extraction. */
const INVOICE_NUMBER_PATTERNS = [
  /INV[-_]?\d+/gi, // INV-12345, INV_12345, INV12345
  /#\d{4,}/g, // #12345
  /invoice\s*#?\s*\d+/gi, // invoice 12345, invoice#12345
  /SI[-_]?\d+/gi, // SI-12345 (sales invoice prefix)
  /BILL[-_]?\d+/gi, // BILL-12345
];

/** IBAN pattern: 2-letter country code + 2 check digits + up to 30 alphanumeric. */
const IBAN_PATTERN = /[A-Z]{2}\d{2}[A-Z0-9]{4,30}/gi;

@Injectable()
export class ReconciliationService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly transactionRepo: BankTransactionRepository,
    private readonly entitiesService: EntitiesService,
    private readonly currencyService: CurrencyService,
    private readonly outstandingVouchers: OutstandingVoucherService,
    private readonly fxRealizedService: FXRealizedService,
  ) {}

  /**
   * Parse a bank transaction's description/reference to extract structured tokens.
   * Deterministic only — no fuzzy matching.
   */
  parseTransactionTokens(txn: {
    description: string | null;
    reference: string | null;
    counterparty_iban: string | null;
    counterparty_descriptor: string | null;
  }): ParsedTransactionTokens {
    const invoiceNumbers: string[] = [];
    const searchFields = [txn.reference, txn.description].filter(
      (f): f is string => f !== null && f.length > 0,
    );

    for (const field of searchFields) {
      for (const pattern of INVOICE_NUMBER_PATTERNS) {
        pattern.lastIndex = 0; // reset regex state
        const matches = field.match(pattern);
        if (matches) {
          for (const m of matches) {
            const normalized = m.replace(/\s+/g, '').toUpperCase();
            if (!invoiceNumbers.includes(normalized)) {
              invoiceNumbers.push(normalized);
            }
          }
        }
      }
    }

    // Use explicit counterparty_iban if present, otherwise try to extract from description.
    let counterpartyIban = txn.counterparty_iban;
    if (!counterpartyIban && txn.description) {
      const ibanMatch = txn.description.match(IBAN_PATTERN);
      if (ibanMatch) {
        counterpartyIban = ibanMatch[0].toUpperCase();
      }
    }

    // Merchant descriptor for card transactions (no IBAN present).
    const merchantDescriptor =
      !counterpartyIban && txn.counterparty_descriptor
        ? txn.counterparty_descriptor
        : null;

    return { invoiceNumbers, counterpartyIban, merchantDescriptor };
  }

  /**
   * Propose matches for all open transactions in a bank statement.
   *
   * Signal hierarchy (strongest first):
   * 1. Invoice number(s) in reference/description → exact-match to voucher(s)
   * 2. Counterparty (IBAN → Entity, merchant descriptor → Entity) → filter AR/AP vouchers
   * 3. Amount + date window (±7 days) → baseline fallback
   *
   * For incoming (amount > 0): candidate unpaid AR vouchers + CustomerPrepayment
   * For outgoing (amount < 0): candidate unpaid AP vouchers
   */
  async proposeMatches(statementId: number): Promise<MatchProposalView[]> {
    const transactions =
      await this.transactionRepo.findByStatementId(statementId);
    const openTxns = transactions.filter((t) => t.status === 'open');

    if (openTxns.length === 0) {
      return [];
    }

    const allProposals: MatchProposal[] = [];

    for (const txn of openTxns) {
      const proposals = await this.proposeMatchesForTransaction(txn);
      allProposals.push(...proposals);
    }

    return this.enrichProposals(allProposals);
  }

  /**
   * Per-transaction reconciliation state for a statement: the matchable base
   * amount, how much is already matched, and the remaining. Drives the operator
   * UI's badges and over-allocation cap. matched sums are BASE cents (matching
   * amount_matched), so the bank line's own amount is converted to base too.
   */
  async getStatementReconciliation(
    statementId: number,
  ): Promise<ReconciliationStatusRow[]> {
    const transactions =
      await this.transactionRepo.findByStatementId(statementId);

    const rows: ReconciliationStatusRow[] = [];
    for (const txn of transactions) {
      const { baseAmount: amountBase } = await this.currencyService.toBase(
        Math.abs(txn.amount),
        txn.currency,
        txn.transaction_date,
      );

      const matched = await this.db
        .selectFrom('reconciliation_match')
        .select((eb) => eb.fn.sum<number>('amount_matched').as('sum'))
        .where('bank_transaction_id', '=', txn.id)
        .executeTakeFirst();
      const matchedSum = Number(matched?.sum ?? 0);
      const remaining = Math.max(0, amountBase - matchedSum);
      const reconStatus: ReconciliationStatusRow['reconStatus'] =
        matchedSum <= 0 ? 'open' : remaining <= 0 ? 'matched' : 'partial';

      rows.push({
        bankTransactionId: txn.id,
        amountBase,
        matchedSum,
        remaining,
        reconStatus,
      });
    }
    return rows;
  }

  /**
   * Enrich raw proposals into operator-facing views: resolve each distinct
   * voucherId to its business object (sales_invoice / expense / prepayment),
   * counterparty name, and remaining balance. voucherId is retained for the
   * execute round-trip but never rendered (ADR-0030).
   */
  private async enrichProposals(
    proposals: MatchProposal[],
  ): Promise<MatchProposalView[]> {
    const views: MatchProposalView[] = [];
    // Small per-voucher resolution (proposal sets are small); memoise by voucherId.
    const cache = new Map<
      number,
      {
        objectType: MatchObjectType;
        objectId: number | null;
        objectLabel: string;
        counterpartyName: string | null;
        voucherRemaining: number;
      }
    >();

    for (const p of proposals) {
      let info = cache.get(p.voucherId);
      if (!info) {
        info = await this.resolveVoucherDisplay(p.voucherId, p.matchType);
        cache.set(p.voucherId, info);
      }
      views.push({ ...p, ...info });
    }
    return views;
  }

  private async resolveVoucherDisplay(
    voucherId: number,
    matchType: MatchType,
  ): Promise<{
    objectType: MatchObjectType;
    objectId: number | null;
    objectLabel: string;
    counterpartyName: string | null;
    voucherRemaining: number;
  }> {
    // Prepayment vouchers carry no business object.
    if (matchType === 'prepayment') {
      const voucherRemaining =
        await this.outstandingVouchers.getRemainingPrepaymentBalance(voucherId);
      return {
        objectType: 'prepayment',
        objectId: null,
        objectLabel: 'Prepayment',
        counterpartyName: null,
        voucherRemaining,
      };
    }

    const voucherRemaining =
      await this.outstandingVouchers.getRemainingVoucherBalance(voucherId);

    const invoice = await this.db
      .selectFrom('sales_invoice')
      .select(['id', 'invoice_number', 'customer_id'])
      .where('voucher_id', '=', voucherId)
      .executeTakeFirst();
    if (invoice) {
      const name = await this.safeEntityName(invoice.customer_id);
      return {
        objectType: 'sales_invoice',
        objectId: invoice.id,
        objectLabel: invoice.invoice_number,
        counterpartyName: name,
        voucherRemaining,
      };
    }

    const expense = await this.db
      .selectFrom('expense')
      .select(['id', 'supplier_id'])
      .where('voucher_id', '=', voucherId)
      .executeTakeFirst();
    if (expense) {
      const name = await this.safeEntityName(expense.supplier_id);
      return {
        objectType: 'expense',
        objectId: expense.id,
        objectLabel: `Expense #${expense.id}`,
        counterpartyName: name,
        voucherRemaining,
      };
    }

    // Voucher with no recognised business object — degrade gracefully.
    return {
      objectType: 'prepayment',
      objectId: null,
      objectLabel: `Voucher settlement`,
      counterpartyName: null,
      voucherRemaining,
    };
  }

  /** Entity name by id, null when unset/unknown (never throws into the UI path). */
  private async safeEntityName(
    entityId: number | null,
  ): Promise<string | null> {
    if (entityId === null) return null;
    try {
      const entity = await this.entitiesService.findById(entityId);
      return entity.name;
    } catch {
      return null;
    }
  }

  /**
   * Propose matches for a single bank transaction.
   * Returns proposals ranked by signal strength.
   */
  private async proposeMatchesForTransaction(txn: {
    id: number;
    amount: number;
    currency: string;
    description: string | null;
    reference: string | null;
    counterparty_iban: string | null;
    counterparty_descriptor: string | null;
    transaction_date: string;
  }): Promise<MatchProposal[]> {
    const isIncoming = txn.amount > 0;
    const tokens = this.parseTransactionTokens(txn);

    // ── Normalise the bank amount to BASE currency ONCE (D7) ────────
    // Voucher remaining balances are `voucher_line.base_amount` in BASE
    // currency, so the bank amount (in the txn's OWN currency) must be
    // converted to base before any signal compares the two. CurrencyService
    // owns base-currency resolution, the same-currency short-circuit, the
    // plugin reference-rate fetch, and the cents rounding (ADR-0004).
    const absRaw = Math.abs(txn.amount);
    const { baseAmount: absBaseAmount } = await this.currencyService.toBase(
      absRaw,
      txn.currency,
      txn.transaction_date,
    );

    // ── Signal 1: Invoice number match (strongest) ──────────────────
    if (tokens.invoiceNumbers.length > 0) {
      const invoiceMatches = await this.matchByInvoiceNumbers(
        txn.id,
        tokens.invoiceNumbers,
        absBaseAmount,
        isIncoming,
      );
      if (invoiceMatches.length > 0) {
        return invoiceMatches;
      }
    }

    // ── Signal 2: Counterparty match ────────────────────────────────
    let entityId: number | null = null;

    if (tokens.counterpartyIban) {
      const entity = await this.entitiesService.resolveByIdentifier(
        'iban',
        tokens.counterpartyIban,
      );
      if (entity) {
        entityId = entity.id;
      }
    } else if (tokens.merchantDescriptor) {
      const entity = await this.entitiesService.resolveByIdentifier(
        'merchant_descriptor',
        tokens.merchantDescriptor,
      );
      if (entity) {
        entityId = entity.id;
      }
    }

    if (entityId !== null) {
      const counterpartyMatches = await this.matchByCounterparty(
        txn.id,
        entityId,
        absBaseAmount,
        txn.transaction_date,
        isIncoming,
      );
      if (counterpartyMatches.length > 0) {
        return counterpartyMatches;
      }
    }

    // ── Signal 3: Amount + date window (fallback) ───────────────────
    return this.matchByAmountAndDate(
      txn.id,
      absBaseAmount,
      txn.transaction_date,
      isIncoming,
    );
  }

  /**
   * Match by invoice numbers found in the transaction reference/description.
   * Looks up sales_invoice or expense records by invoice_number, then finds
   * their posted vouchers.
   */
  private async matchByInvoiceNumbers(
    bankTransactionId: number,
    invoiceNumbers: string[],
    absBaseAmount: number,
    isIncoming: boolean,
  ): Promise<MatchProposal[]> {
    const proposals: MatchProposal[] = [];

    for (const invNum of invoiceNumbers) {
      // Try sales_invoice first (for incoming / AR).
      if (isIncoming) {
        const salesInvoice = await this.db
          .selectFrom('sales_invoice')
          .select(['id', 'voucher_id', 'gross_amount', 'currency'])
          .where('invoice_number', '=', invNum)
          .where('status', '=', 'posted')
          .where('voucher_id', 'is not', null)
          .executeTakeFirst();

        if (salesInvoice && salesInvoice.voucher_id) {
          const remaining =
            await this.outstandingVouchers.getRemainingVoucherBalance(
              salesInvoice.voucher_id,
            );
          if (remaining > 0) {
            const amountMatched = Math.min(absBaseAmount, remaining);
            const matchType: MatchType =
              amountMatched === remaining && amountMatched === absBaseAmount
                ? 'exact'
                : 'partial';
            proposals.push({
              bankTransactionId,
              voucherId: salesInvoice.voucher_id,
              matchType,
              amountMatched,
              confidence: 'high',
              signal: 'invoice_number',
            });
          }
        }
      }
      // Outgoing / AP payments have no invoice-number key: the `expense` table
      // has no `invoice_number` column, so the invoice-number signal applies to
      // incoming / AR only. Outgoing payments rely on the counterparty and
      // amount-and-date signals (handled in proposeMatchesForTransaction).
    }

    return proposals;
  }

  /**
   * Match by counterparty entity.
   * Finds AR/AP vouchers linked to the entity via sales_invoice.customer_id
   * or expense.supplier_id.
   */
  private async matchByCounterparty(
    bankTransactionId: number,
    entityId: number,
    absBaseAmount: number,
    _transactionDate: string,
    isIncoming: boolean,
  ): Promise<MatchProposal[]> {
    const proposals: MatchProposal[] = [];
    const candidates = await this.getCandidateVouchers(entityId, isIncoming);

    for (const candidate of candidates) {
      if (candidate.remainingBalance <= 0) continue;

      const amountMatched = Math.min(absBaseAmount, candidate.remainingBalance);
      if (amountMatched <= 0) continue;

      // Determine match type.
      const matchType: MatchType = candidate.isPrepayment
        ? 'prepayment'
        : amountMatched === candidate.remainingBalance &&
            amountMatched === absBaseAmount
          ? 'exact'
          : 'partial';

      // Confidence: high if amount matches exactly, medium if partial.
      const confidence: MatchConfidence =
        amountMatched === absBaseAmount &&
        amountMatched === candidate.remainingBalance
          ? 'high'
          : 'medium';

      proposals.push({
        bankTransactionId,
        voucherId: candidate.voucherId,
        matchType,
        amountMatched,
        confidence,
        signal: 'counterparty',
      });
    }

    // Sort by confidence (high first), then by remaining balance (closest match first).
    proposals.sort((a, b) => {
      if (a.confidence !== b.confidence) {
        return a.confidence === 'high' ? -1 : 1;
      }
      return a.amountMatched - b.amountMatched;
    });

    return proposals;
  }

  /**
   * Fallback: match by amount and date window (±7 days).
   * Finds any unpaid AR/AP voucher with matching amount within the date window.
   */
  private async matchByAmountAndDate(
    bankTransactionId: number,
    absBaseAmount: number,
    transactionDate: string,
    isIncoming: boolean,
  ): Promise<MatchProposal[]> {
    const proposals: MatchProposal[] = [];
    const candidates = await this.getCandidateVouchersByAmountAndDate(
      absBaseAmount,
      transactionDate,
      isIncoming,
    );

    for (const candidate of candidates) {
      if (candidate.remainingBalance <= 0) continue;

      const amountMatched = Math.min(absBaseAmount, candidate.remainingBalance);
      if (amountMatched <= 0) continue;

      const matchType: MatchType = candidate.isPrepayment
        ? 'prepayment'
        : amountMatched === candidate.remainingBalance &&
            amountMatched === absBaseAmount
          ? 'exact'
          : 'partial';

      proposals.push({
        bankTransactionId,
        voucherId: candidate.voucherId,
        matchType,
        amountMatched,
        confidence: 'low',
        signal: 'amount_date',
      });
    }

    return proposals;
  }

  /**
   * Get candidate vouchers for a given entity, delegating the join chain,
   * account-code/polarity, and remaining-balance maths to
   * {@link OutstandingVoucherService}.
   * For incoming: AR vouchers (via sales_invoice) + CustomerPrepayment vouchers.
   * For outgoing: AP vouchers (via expense).
   */
  private async getCandidateVouchers(
    entityId: number,
    isIncoming: boolean,
  ): Promise<CandidateVoucher[]> {
    if (isIncoming) {
      const arCandidates =
        await this.outstandingVouchers.findArCandidatesByCounterparty(entityId);
      const prepaymentCandidates =
        await this.outstandingVouchers.findCustomerPrepaymentCandidates(
          entityId,
        );
      return [...arCandidates, ...prepaymentCandidates];
    }
    return this.outstandingVouchers.findApCandidatesByCounterparty(entityId);
  }

  /**
   * Get candidate vouchers by amount and date window (no entity filter).
   * Fallback when no invoice number or counterparty match is found. The
   * ±7-day window, join chain, and single remaining-balance path all live in
   * {@link OutstandingVoucherService}; the `remaining <= 0` skip stays here so
   * the proposal-building loops below see only positive-balance candidates.
   */
  private async getCandidateVouchersByAmountAndDate(
    _absAmount: number,
    transactionDate: string,
    isIncoming: boolean,
  ): Promise<CandidateVoucher[]> {
    const candidates = isIncoming
      ? await this.outstandingVouchers.findArCandidatesByAmountAndDate(
          transactionDate,
        )
      : await this.outstandingVouchers.findApCandidatesByAmountAndDate(
          transactionDate,
        );
    return candidates.filter((c) => c.remainingBalance > 0);
  }

  /**
   * Test-only public wrapper around the consolidated remaining-balance path.
   */
  getRemainingVoucherBalanceForTest(voucherId: number): Promise<number> {
    return this.outstandingVouchers.getRemainingVoucherBalance(voucherId);
  }

  /**
   * Record one or more **ReconciliationMatch**es — the deep operation that
   * enforces the "no over-match / no duplicate pair" invariant ATOMICALLY.
   *
   * ── Why this is a transaction, not a loop of inserts ──────────────────────
   * The invariant — a match must never push a Voucher's matched total past its
   * outstanding **Receivable** / **Payable** (or undrawn prepayment), and the
   * SAME `(bank line, Voucher)` pair must never be recorded twice — used to
   * live only in the proposal phase's `min(amount, remaining)`. Execution
   * trusted the proposal and inserted blind, so two concurrent or repeated
   * executes could over-match (1500 against a 1000 invoice) and a stale
   * proposal could duplicate a pair. We now re-read the outstanding balance and
   * INSERT inside ONE transaction, so the check the INSERT relies on cannot go
   * stale between read and write. N:M stays legitimate: many Vouchers per bank
   * line and many bank lines per Voucher are all distinct pairs the
   * UNIQUE(bank_transaction_id, voucher_id) index (migration 031) admits — only
   * the same pair and over-matching are rejected.
   *
   * Realized-FX posting happens AFTER the matching transaction commits: it
   * posts its own balanced **Voucher** through PostingService and is not part
   * of the match-recording invariant.
   */
  async executeMatch(proposals: MatchProposal[]): Promise<ExecuteMatchResult> {
    if (proposals.length === 0) {
      throw new BadRequestException('No match proposals provided');
    }

    for (const proposal of proposals) {
      if (proposal.amountMatched <= 0) {
        throw new BadRequestException(
          `amount_matched must be positive, got ${proposal.amountMatched}`,
        );
      }
    }

    // Validate all proposals reference existing transactions and vouchers.
    const txnIds = [...new Set(proposals.map((p) => p.bankTransactionId))];

    const txnMap = new Map<number, BankTransactionRecord>();
    for (const txnId of txnIds) {
      const txn = await this.transactionRepo.findById(txnId);
      if (!txn) {
        throw new NotFoundException(`Bank transaction ${txnId} not found`);
      }
      txnMap.set(txnId, txn);
    }

    // Precompute each bank line's matchable BASE amount BEFORE the atomic
    // block. The line amount is immutable, and currency conversion cannot run
    // inside the better-sqlite3 sync transaction. amount_matched is BASE cents,
    // so the per-line cap must be base too (bank_transaction.amount is the
    // txn's OWN currency).
    const txnBaseAmount = new Map<number, number>();
    for (const txnId of txnIds) {
      const txn = txnMap.get(txnId);
      if (!txn) {
        throw new NotFoundException(`Bank transaction ${txnId} not found`);
      }
      const { baseAmount } = await this.currencyService.toBase(
        Math.abs(txn.amount),
        txn.currency,
        txn.transaction_date,
      );
      txnBaseAmount.set(txnId, baseAmount);
    }

    const now = Math.floor(Date.now() / 1000);

    // ── Atomic check-then-insert ──────────────────────────────────────────
    // The remaining-balance read and the INSERT run on the SAME transaction
    // connection, so the outstanding balance the rejection relies on cannot
    // change between read and write. Proposals in this batch that target the
    // same Voucher accumulate against ONE outstanding figure, so a batch can no
    // more over-match than two separate executes can.
    const records = await this.db.transaction().execute(async (trx) => {
      const batchMatchedByVoucher = new Map<number, number>();
      const inserted: ReconciliationMatchRecord[] = [];

      for (const proposal of proposals) {
        const voucher = await trx
          .selectFrom('voucher')
          .select('id')
          .where('id', '=', proposal.voucherId)
          .executeTakeFirst();
        if (!voucher) {
          throw new NotFoundException(
            `Voucher ${proposal.voucherId} not found`,
          );
        }

        // Re-read the outstanding AR/AP (or prepayment) balance INSIDE the
        // transaction, then subtract anything already matched earlier in THIS
        // batch against the same Voucher.
        const persistedRemaining =
          proposal.matchType === 'prepayment'
            ? await this.outstandingVouchers.getRemainingPrepaymentBalance(
                proposal.voucherId,
                trx,
              )
            : await this.outstandingVouchers.getRemainingVoucherBalance(
                proposal.voucherId,
                trx,
              );
        const alreadyInBatch =
          batchMatchedByVoucher.get(proposal.voucherId) ?? 0;
        const available = persistedRemaining - alreadyInBatch;

        if (proposal.amountMatched > available) {
          throw new ConflictException(
            `Match of ${proposal.amountMatched} would over-match voucher ` +
              `${proposal.voucherId}: only ${available} outstanding remains`,
          );
        }

        // ── Bank-line over-allocation guard (symmetric to the voucher guard) ──
        // SUM(amount_matched) for this bank line — everything matched so far
        // (persisted + this batch's own inserts, both visible to this re-read on
        // the SAME transaction connection) plus the current proposal — must not
        // exceed the line's BASE amount. The re-read already accounts for prior
        // batch inserts, so no separate batch tally is added here (that would
        // double-count). batchMatchedByTxn is kept purely diagnostic of this
        // batch's own contribution.
        const persistedTxnMatched = await trx
          .selectFrom('reconciliation_match')
          .select((eb) => eb.fn.sum<number>('amount_matched').as('sum'))
          .where('bank_transaction_id', '=', proposal.bankTransactionId)
          .executeTakeFirst();
        const txnMatchedSoFar = Number(persistedTxnMatched?.sum ?? 0);
        const lineCap = txnBaseAmount.get(proposal.bankTransactionId) ?? 0;
        if (txnMatchedSoFar + proposal.amountMatched > lineCap) {
          throw new ConflictException(
            `Match of ${proposal.amountMatched} would over-allocate bank line ` +
              `${proposal.bankTransactionId}: only ` +
              `${lineCap - txnMatchedSoFar} of the line remains`,
          );
        }

        const row = await this.insertMatchRow(trx, proposal, now);
        batchMatchedByVoucher.set(
          proposal.voucherId,
          alreadyInBatch + proposal.amountMatched,
        );
        inserted.push(row);
      }

      return inserted;
    });

    // ── Realized FX (post-commit; posts its own Voucher) ──────────────────
    const fxResults: FXRealizedResult[] = [];
    for (const proposal of proposals) {
      const txn = txnMap.get(proposal.bankTransactionId);
      if (
        txn &&
        txn.source_currency !== null &&
        txn.source_currency !== txn.currency
      ) {
        const fxResult = await this.fxRealizedService.computeAndPost(
          proposal.voucherId,
          proposal.bankTransactionId,
          proposal.amountMatched,
        );
        fxResults.push(fxResult);
      } else {
        fxResults.push({
          status: 'no_fx',
          message: 'Same currency — no realized FX',
        });
      }
    }

    return { records, fxResults };
  }

  /**
   * Insert one reconciliation_match row on the given transaction, translating a
   * UNIQUE(bank_transaction_id, voucher_id) violation (migration 031) into a
   * clear duplicate-pair rejection. The constraint is the backstop behind the
   * outstanding-balance re-check; a duplicate pair from a stale proposal that
   * slips past the balance check (e.g. a zero-outstanding re-match) still cannot
   * be recorded twice.
   */
  private async insertMatchRow(
    trx: Transaction<Database>,
    proposal: MatchProposal,
    now: number,
  ): Promise<ReconciliationMatchRecord> {
    let inserted: {
      id: number;
      bank_transaction_id: number;
      voucher_id: number;
      match_type: string;
      amount_matched: number;
      created_at: number;
    };
    try {
      [inserted] = await trx
        .insertInto('reconciliation_match')
        .values({
          bank_transaction_id: proposal.bankTransactionId,
          voucher_id: proposal.voucherId,
          match_type: proposal.matchType,
          amount_matched: proposal.amountMatched,
          created_at: now,
        })
        .returningAll()
        .execute();
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException(
          `Duplicate reconciliation match: bank transaction ` +
            `${proposal.bankTransactionId} is already matched to voucher ` +
            `${proposal.voucherId}`,
        );
      }
      throw err;
    }

    return {
      id: inserted.id,
      bankTransactionId: inserted.bank_transaction_id,
      voucherId: inserted.voucher_id,
      matchType: inserted.match_type as MatchType,
      amountMatched: inserted.amount_matched,
      createdAt: inserted.created_at,
    };
  }

  /** Whether an unknown error is a SQLite UNIQUE-constraint violation. */
  private isUniqueViolation(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;
    const code = (err as { code?: unknown }).code;
    const message = (err as { message?: unknown }).message;
    return (
      code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      code === 'SQLITE_CONSTRAINT' ||
      (typeof message === 'string' && message.includes('UNIQUE constraint'))
    );
  }
}
