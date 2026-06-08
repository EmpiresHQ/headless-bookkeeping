import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { BankTransactionRepository } from '../bank/bank-transaction.repository';
import { BankTransactionRecord } from '../bank/bank-statement.types';
import { EntitiesService } from '../entities/entities.service';
import { CurrencyService } from '../currency/currency.service';
import { OutstandingVoucherService } from './outstanding-voucher.service';
import { FXRealizedService, FXRealizedResult } from './fx-realized.service';
import {
  MatchProposal,
  MatchType,
  MatchConfidence,
  ReconciliationMatchRecord,
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
  async proposeMatches(statementId: number): Promise<MatchProposal[]> {
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

    return allProposals;
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
   * Execute proposed matches by inserting reconciliation_match records.
   * For foreign-currency settlements, auto-posts realized-FX vouchers.
   */
  async executeMatch(proposals: MatchProposal[]): Promise<ExecuteMatchResult> {
    if (proposals.length === 0) {
      throw new BadRequestException('No match proposals provided');
    }

    // Validate all proposals reference existing transactions and vouchers.
    const txnIds = [...new Set(proposals.map((p) => p.bankTransactionId))];
    const voucherIds = [...new Set(proposals.map((p) => p.voucherId))];

    const txnMap = new Map<number, BankTransactionRecord>();
    for (const txnId of txnIds) {
      const txn = await this.transactionRepo.findById(txnId);
      if (!txn) {
        throw new NotFoundException(`Bank transaction ${txnId} not found`);
      }
      txnMap.set(txnId, txn);
    }

    for (const vid of voucherIds) {
      const voucher = await this.db
        .selectFrom('voucher')
        .select('id')
        .where('id', '=', vid)
        .executeTakeFirst();
      if (!voucher) {
        throw new NotFoundException(`Voucher ${vid} not found`);
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const records: ReconciliationMatchRecord[] = [];
    const fxResults: FXRealizedResult[] = [];

    for (const proposal of proposals) {
      if (proposal.amountMatched <= 0) {
        throw new BadRequestException(
          `amount_matched must be positive, got ${proposal.amountMatched}`,
        );
      }

      const [inserted] = await this.db
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

      records.push({
        id: inserted.id,
        bankTransactionId: inserted.bank_transaction_id,
        voucherId: inserted.voucher_id,
        matchType: inserted.match_type as MatchType,
        amountMatched: inserted.amount_matched,
        createdAt: inserted.created_at,
      });

      // Compute realized FX for foreign-currency settlements.
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
}
