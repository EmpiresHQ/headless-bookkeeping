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
import { EntitiesService } from '../entities/entities.service';
import { CurrencyService } from '../currency/currency.service';
import { OutstandingVoucherService } from './outstanding-voucher.service';
import { FXRealizedService } from './fx-realized.service';
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
  MatchCandidateView,
  MatchCandidatesResult,
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

/**
 * Amount-and-date fallback tolerance. A candidate qualifies only if its
 * remaining balance is within `max(FLOOR, PCT · bankBase)` of the bank line's
 * base amount. The relative band absorbs card-settlement FX drift (a charge
 * booked at the reference rate vs settled at the card rate); the absolute floor
 * keeps tiny amounts from collapsing to a near-zero window. Without this, the
 * fallback returned EVERY voucher in the date window regardless of amount.
 */
const AMOUNT_DATE_TOLERANCE_FLOOR = 100; // 1 unit of base currency, in cents
const AMOUNT_DATE_TOLERANCE_PCT = 0.05;

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
   * Auto-stage the unambiguous, high-confidence matches in a freshly imported
   * statement as DRAFTs (behind approvals). Deliberately conservative: the
   * machine NEVER posts to the ledger, it only proposes for human approval, and
   * only when the match is beyond doubt. A line is auto-staged ONLY when it has
   * EXACTLY ONE eligible candidate that is:
   *   - signal `invoice_number` (a deterministic invoice-number hit),
   *   - matchType `exact` (settles the line and the voucher to the cent),
   *   - single-currency (auto-stage must never trigger a realized-FX voucher).
   * Anything ambiguous (≥2 candidates), partial, FX, or weaker-signal is left
   * for a human. Idempotent: lines already carrying a match are skipped, so a
   * re-import or re-run never double-stages.
   */
  async autoStageStatement(
    statementId: number,
    requestedBy = 'system',
  ): Promise<{ staged: number }> {
    const txns = await this.transactionRepo.findByStatementId(statementId);
    if (txns.length === 0) {
      return { staged: 0 };
    }

    const proposals = await this.proposeMatches(statementId);

    // Multi-currency lines are excluded — auto-stage must never post FX.
    const multiCurrency = new Set(
      txns
        .filter(
          (t) => t.source_currency !== null && t.source_currency !== t.currency,
        )
        .map((t) => t.id),
    );

    // Idempotency: skip lines that already carry a match (draft or active).
    const existing = await this.db
      .selectFrom('reconciliation_match')
      .select('bank_transaction_id')
      .where(
        'bank_transaction_id',
        'in',
        txns.map((t) => t.id),
      )
      .execute();
    const alreadyMatched = new Set(existing.map((e) => e.bank_transaction_id));

    const eligible = proposals.filter(
      (p) =>
        p.signal === 'invoice_number' &&
        p.matchType === 'exact' &&
        !multiCurrency.has(p.bankTransactionId) &&
        !alreadyMatched.has(p.bankTransactionId),
    );

    // Ambiguity guard: only a line with EXACTLY ONE eligible candidate.
    const byLine = new Map<number, MatchProposalView[]>();
    for (const p of eligible) {
      const list = byLine.get(p.bankTransactionId) ?? [];
      list.push(p);
      byLine.set(p.bankTransactionId, list);
    }
    const unambiguous = [...byLine.values()]
      .filter((list) => list.length === 1)
      .map((list) => list[0]);

    if (unambiguous.length === 0) {
      return { staged: 0 };
    }

    await this.executeMatch(unambiguous, requestedBy);
    return { staged: unambiguous.length };
  }

  /**
   * The open business objects a bank line can be MANUALLY matched against, plus
   * the line's still-unallocated base amount. Direction is derived from the
   * line's sign (incoming → AR invoices, outgoing → AP expenses); prepayments
   * are out of scope for v1 manual matching. The returned `voucherId` feeds the
   * execute round-trip but is never rendered (ADR-0030).
   */
  async getMatchCandidates(
    statementId: number,
    bankTransactionId: number,
  ): Promise<MatchCandidatesResult> {
    const txn = await this.transactionRepo.findById(bankTransactionId);
    if (!txn || txn.statement_id !== statementId) {
      throw new NotFoundException(
        `Bank transaction ${bankTransactionId} not found on statement ${statementId}`,
      );
    }

    const isIncoming = txn.amount >= 0;
    const candidates = isIncoming
      ? await this.outstandingVouchers.findAllArCandidates()
      : await this.outstandingVouchers.findAllApCandidates();

    const views: MatchCandidateView[] = [];
    for (const c of candidates) {
      if (c.remainingBalance <= 0) continue;
      const info = await this.resolveVoucherDisplay(c.voucherId, 'exact');
      views.push({
        voucherId: c.voucherId,
        objectType: info.objectType,
        objectId: info.objectId,
        objectLabel: info.objectLabel,
        counterpartyName: info.counterpartyName,
        voucherRemaining: info.voucherRemaining,
      });
    }

    // How much of the line is still unallocated (active matches only), BASE cents.
    const { baseAmount } = await this.currencyService.toBase(
      Math.abs(txn.amount),
      txn.currency,
      txn.transaction_date,
    );
    const matched = await this.db
      .selectFrom('reconciliation_match')
      .select((eb) => eb.fn.sum<number>('amount_matched').as('sum'))
      .where('bank_transaction_id', '=', bankTransactionId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    const lineRemaining = Math.max(0, baseAmount - Number(matched?.sum ?? 0));

    return { bankTransactionId, lineRemaining, candidates: views };
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
        // Only ACTIVE matches reconcile a line; a draft is staged, not settled.
        .where('status', '=', 'active')
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
      // Outgoing / AP: look up the supplier's invoice number on the expense
      // (migration 036). Symmetric to the AR branch — the bank line must carry a
      // token equal to `expense.supplier_invoice_number` (e.g. a transfer that
      // references "INV-1756"). Card descriptors carry no such token, so those
      // fall through to the counterparty / amount-date signals.
      else {
        const expense = await this.db
          .selectFrom('expense')
          .select(['id', 'voucher_id', 'gross_amount', 'currency'])
          .where('supplier_invoice_number', '=', invNum)
          .where('status', '=', 'posted')
          .where('voucher_id', 'is not', null)
          .executeTakeFirst();

        if (expense && expense.voucher_id) {
          const remaining =
            await this.outstandingVouchers.getRemainingVoucherBalance(
              expense.voucher_id,
            );
          if (remaining > 0) {
            const amountMatched = Math.min(absBaseAmount, remaining);
            const matchType: MatchType =
              amountMatched === remaining && amountMatched === absBaseAmount
                ? 'exact'
                : 'partial';
            proposals.push({
              bankTransactionId,
              voucherId: expense.voucher_id,
              matchType,
              amountMatched,
              confidence: 'high',
              signal: 'invoice_number',
            });
          }
        }
      }
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
    absBaseAmount: number,
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

    // The SQL query filters by the ±7-day window only; apply the amount
    // tolerance here, against the voucher's REMAINING balance (the figure this
    // bank line could settle), not its original line amount.
    const tolerance = Math.max(
      AMOUNT_DATE_TOLERANCE_FLOOR,
      Math.round(absBaseAmount * AMOUNT_DATE_TOLERANCE_PCT),
    );
    return candidates.filter(
      (c) =>
        c.remainingBalance > 0 &&
        Math.abs(c.remainingBalance - absBaseAmount) <= tolerance,
    );
  }

  /**
   * Test-only public wrapper around the consolidated remaining-balance path.
   */
  getRemainingVoucherBalanceForTest(voucherId: number): Promise<number> {
    return this.outstandingVouchers.getRemainingVoucherBalance(voucherId);
  }

  /**
   * Stage one or more **ReconciliationMatch**es as DRAFTs behind an Approval.
   *
   * Nothing settles or posts to the ledger here. Each match is recorded with
   * `status = 'draft'` (so it does NOT reduce any outstanding **Receivable** /
   * **Payable**) and a pending Approval of type `reconciliation_match` is created
   * alongside it. The settlement — promoting the draft to `active` and posting
   * any realized-FX voucher — happens only when a human approves (see
   * {@link activateMatch}). The UNIQUE(bank_transaction_id, voucher_id) index
   * still rejects a duplicate pair; the over-match and bank-line over-allocation
   * invariants are enforced at ACTIVATION, against the `active` set.
   */
  async executeMatch(
    proposals: MatchProposal[],
    requestedBy = 'operator',
  ): Promise<ExecuteMatchResult> {
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

    // Validate all proposals reference existing transactions.
    const txnIds = [...new Set(proposals.map((p) => p.bankTransactionId))];
    for (const txnId of txnIds) {
      const txn = await this.transactionRepo.findById(txnId);
      if (!txn) {
        throw new NotFoundException(`Bank transaction ${txnId} not found`);
      }
    }

    const now = Math.floor(Date.now() / 1000);

    return this.db.transaction().execute(async (trx) => {
      const records: ReconciliationMatchRecord[] = [];
      const approvals: { id: number; matchId: number }[] = [];

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

        // Draft link — settles nothing until activated through its approval.
        const row = await this.insertMatchRow(trx, proposal, now);

        const approval = await trx
          .insertInto('approval')
          .values({
            object_type: 'reconciliation_match',
            object_id: row.id,
            status: 'pending',
            requested_by: requestedBy,
            created_at: now,
            resolved_at: null,
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        records.push(row);
        approvals.push({ id: approval.id, matchId: row.id });
      }

      return { records, approvals };
    });
  }

  /**
   * Promote a DRAFT match to `active` — the approval seam where the settlement
   * actually takes effect. Re-checks the over-match and bank-line
   * over-allocation invariants against the `active` set INSIDE a transaction (a
   * still-draft match is excluded from the read, so it is checked against what
   * is already settled), flips the status, then posts the realized-FX voucher
   * for a multi-currency settlement and records its id on the match. Idempotent:
   * an already-active match is a no-op.
   */
  async activateMatch(
    matchId: number,
  ): Promise<{ matchId: number; fxVoucherId: number | null }> {
    const match = await this.db
      .selectFrom('reconciliation_match')
      .select([
        'id',
        'bank_transaction_id',
        'voucher_id',
        'match_type',
        'amount_matched',
        'status',
        'fx_voucher_id',
      ])
      .where('id', '=', matchId)
      .executeTakeFirst();
    if (!match) {
      throw new NotFoundException(`Reconciliation match ${matchId} not found`);
    }
    if (match.status === 'active') {
      return { matchId, fxVoucherId: match.fx_voucher_id };
    }

    const txn = await this.transactionRepo.findById(match.bank_transaction_id);
    if (!txn) {
      throw new NotFoundException(
        `Bank transaction ${match.bank_transaction_id} not found`,
      );
    }

    // Bank-line cap in BASE cents — currency conversion cannot run inside the
    // better-sqlite3 sync transaction, so resolve it up front.
    const { baseAmount: lineCap } = await this.currencyService.toBase(
      Math.abs(txn.amount),
      txn.currency,
      txn.transaction_date,
    );

    await this.db.transaction().execute(async (trx) => {
      const remaining =
        match.match_type === 'prepayment'
          ? await this.outstandingVouchers.getRemainingPrepaymentBalance(
              match.voucher_id,
              trx,
            )
          : await this.outstandingVouchers.getRemainingVoucherBalance(
              match.voucher_id,
              trx,
            );
      if (match.amount_matched > remaining) {
        throw new ConflictException(
          `Match of ${match.amount_matched} would over-match voucher ` +
            `${match.voucher_id}: only ${remaining} outstanding remains`,
        );
      }

      const txnActive = await trx
        .selectFrom('reconciliation_match')
        .select((eb) => eb.fn.sum<number>('amount_matched').as('sum'))
        .where('bank_transaction_id', '=', match.bank_transaction_id)
        .where('status', '=', 'active')
        .executeTakeFirst();
      const activeSoFar = Number(txnActive?.sum ?? 0);
      if (activeSoFar + match.amount_matched > lineCap) {
        throw new ConflictException(
          `Match of ${match.amount_matched} would over-allocate bank line ` +
            `${match.bank_transaction_id}: only ${lineCap - activeSoFar} of ` +
            `the line remains`,
        );
      }

      const flipped = await trx
        .updateTable('reconciliation_match')
        .set({ status: 'active' })
        .where('id', '=', matchId)
        .where('status', '=', 'draft')
        .executeTakeFirst();
      if (Number(flipped.numUpdatedRows) === 0) {
        throw new ConflictException(
          `Reconciliation match ${matchId} is no longer draft`,
        );
      }
    });

    // ── Realized FX (post-commit; posts its own voucher) ──────────────────
    let fxVoucherId: number | null = null;
    if (txn.source_currency !== null && txn.source_currency !== txn.currency) {
      const fxResult = await this.fxRealizedService.computeAndPost(
        match.voucher_id,
        match.bank_transaction_id,
        match.amount_matched,
      );
      if (fxResult.status === 'posted' && fxResult.voucher) {
        fxVoucherId = fxResult.voucher.id;
        await this.db
          .updateTable('reconciliation_match')
          .set({ fx_voucher_id: fxVoucherId })
          .where('id', '=', matchId)
          .execute();
      }
    }

    return { matchId, fxVoucherId };
  }

  /**
   * Discard a DRAFT match (its approval was rejected). Ledger-neutral — a draft
   * never settled anything nor posted FX, so it is simply deleted. Refuses an
   * `active` match (use {@link unmatch}, which also reverses any FX voucher).
   */
  async discardDraftMatch(matchId: number): Promise<void> {
    const match = await this.db
      .selectFrom('reconciliation_match')
      .select(['id', 'status'])
      .where('id', '=', matchId)
      .executeTakeFirst();
    if (!match) {
      throw new NotFoundException(`Reconciliation match ${matchId} not found`);
    }
    if (match.status !== 'draft') {
      throw new ConflictException(
        `Reconciliation match ${matchId} is ${match.status}, not draft; ` +
          `use unmatch to reverse an active match`,
      );
    }
    await this.db
      .deleteFrom('reconciliation_match')
      .where('id', '=', matchId)
      .where('status', '=', 'draft')
      .execute();
  }

  /**
   * Undo a reconciliation match.
   *
   * The match link lives in a sub-ledger, NOT the general ledger, so removing it
   * is ledger-neutral: the voucher's outstanding AR/AP recomputes from the
   * remaining `active` matches. The one GL artifact a match can leave behind is a
   * realized-FX voucher (multi-currency settlement); that IS immutable, so it is
   * reversed via {@link FXRealizedService} (mirror voucher + `reverses_id`,
   * redirected out of a locked period) BEFORE the link is deleted. A `draft`
   * match never reached the ledger nor posted FX, so undoing it is a plain
   * delete.
   */
  async unmatch(matchId: number): Promise<{
    matchId: number;
    bankTransactionId: number;
    voucherId: number;
    fxReversalVoucherId: number | null;
  }> {
    const match = await this.db
      .selectFrom('reconciliation_match')
      .select(['id', 'bank_transaction_id', 'voucher_id', 'fx_voucher_id'])
      .where('id', '=', matchId)
      .executeTakeFirst();
    if (!match) {
      throw new NotFoundException(`Reconciliation match ${matchId} not found`);
    }

    // Reverse the realized-FX voucher first (if any). If this throws (e.g. no
    // open period to receive a locked-period redirect) the link is left intact.
    let fxReversalVoucherId: number | null = null;
    if (match.fx_voucher_id !== null) {
      const reversal = await this.fxRealizedService.reverseFxVoucher(
        match.fx_voucher_id,
      );
      fxReversalVoucherId = reversal.id;
    }

    await this.db
      .deleteFrom('reconciliation_match')
      .where('id', '=', matchId)
      .execute();

    return {
      matchId,
      bankTransactionId: match.bank_transaction_id,
      voucherId: match.voucher_id,
      fxReversalVoucherId,
    };
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
          // Staged behind an approval — settles nothing until activated.
          status: 'draft',
          signal: proposal.signal,
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
