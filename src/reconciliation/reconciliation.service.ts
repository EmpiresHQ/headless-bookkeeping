import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { BankTransactionRepository } from '../bank/bank-transaction.repository';
import { EntitiesService } from '../entities/entities.service';
import {
  MatchProposal,
  MatchType,
  MatchConfidence,
  ReconciliationMatchRecord,
  ParsedTransactionTokens,
  CandidateVoucher,
} from './reconciliation.types';

/** Regex patterns for deterministic token extraction. */
const INVOICE_NUMBER_PATTERNS = [
  /INV[-_]?\d+/gi,          // INV-12345, INV_12345, INV12345
  /#\d{4,}/g,               // #12345
  /invoice\s*#?\s*\d+/gi,   // invoice 12345, invoice#12345
  /SI[-_]?\d+/gi,           // SI-12345 (sales invoice prefix)
  /BILL[-_]?\d+/gi,         // BILL-12345
];

/** IBAN pattern: 2-letter country code + 2 check digits + up to 30 alphanumeric. */
const IBAN_PATTERN = /[A-Z]{2}\d{2}[A-Z0-9]{4,30}/gi;

/** Date window for amount+date matching (±7 days). */
const DATE_WINDOW_DAYS = 7;

@Injectable()
export class ReconciliationService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly transactionRepo: BankTransactionRepository,
    private readonly entitiesService: EntitiesService,
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
    const transactions = await this.transactionRepo.findByStatementId(statementId);
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
    description: string | null;
    reference: string | null;
    counterparty_iban: string | null;
    counterparty_descriptor: string | null;
    transaction_date: string;
  }): Promise<MatchProposal[]> {
    const absAmount = Math.abs(txn.amount);
    const isIncoming = txn.amount > 0;
    const tokens = this.parseTransactionTokens(txn);

    // ── Signal 1: Invoice number match (strongest) ──────────────────
    if (tokens.invoiceNumbers.length > 0) {
      const invoiceMatches = await this.matchByInvoiceNumbers(
        txn.id,
        tokens.invoiceNumbers,
        absAmount,
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
        absAmount,
        txn.transaction_date,
        isIncoming,
      );
      if (counterpartyMatches.length > 0) {
        return counterpartyMatches;
      }
    }

    // ── Signal 3: Amount + date window (fallback) ───────────────────
    return this.matchByAmountAndDate(txn.id, absAmount, txn.transaction_date, isIncoming);
  }

  /**
   * Match by invoice numbers found in the transaction reference/description.
   * Looks up sales_invoice or expense records by invoice_number, then finds
   * their posted vouchers.
   */
  private async matchByInvoiceNumbers(
    bankTransactionId: number,
    invoiceNumbers: string[],
    absAmount: number,
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
          const remaining = await this.getRemainingVoucherBalance(
            salesInvoice.voucher_id,
          );
          if (remaining > 0) {
            const amountMatched = Math.min(absAmount, remaining);
            const matchType: MatchType =
              amountMatched === remaining && amountMatched === absAmount
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
      } else {
        // For outgoing / AP, try expense by amount within the invoice signal context.
        const expenses = await this.db
          .selectFrom('expense')
          .select(['id', 'voucher_id', 'gross_amount', 'currency'])
          .where('status', '=', 'posted')
          .where('voucher_id', 'is not', null)
          .execute();

        for (const exp of expenses) {
          if (exp.voucher_id) {
            const remaining = await this.getRemainingVoucherBalance(exp.voucher_id);
            if (remaining > 0) {
              const amountMatched = Math.min(absAmount, remaining);
              // Only propose if amount matches closely
              if (amountMatched === absAmount || amountMatched === remaining) {
                const matchType: MatchType =
                  amountMatched === remaining && amountMatched === absAmount
                    ? 'exact'
                    : 'partial';
                proposals.push({
                  bankTransactionId,
                  voucherId: exp.voucher_id,
                  matchType,
                  amountMatched,
                  confidence: 'high',
                  signal: 'invoice_number',
                });
              }
            }
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
    absAmount: number,
    _transactionDate: string,
    isIncoming: boolean,
  ): Promise<MatchProposal[]> {
    const proposals: MatchProposal[] = [];
    const candidates = await this.getCandidateVouchers(entityId, isIncoming);

    for (const candidate of candidates) {
      if (candidate.remainingBalance <= 0) continue;

      const amountMatched = Math.min(absAmount, candidate.remainingBalance);
      if (amountMatched <= 0) continue;

      // Determine match type.
      const matchType: MatchType = candidate.isPrepayment
        ? 'prepayment'
        : amountMatched === candidate.remainingBalance && amountMatched === absAmount
          ? 'exact'
          : 'partial';

      // Confidence: high if amount matches exactly, medium if partial.
      const confidence: MatchConfidence =
        amountMatched === absAmount && amountMatched === candidate.remainingBalance
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
    absAmount: number,
    transactionDate: string,
    isIncoming: boolean,
  ): Promise<MatchProposal[]> {
    const proposals: MatchProposal[] = [];
    const candidates = await this.getCandidateVouchersByAmountAndDate(
      absAmount,
      transactionDate,
      isIncoming,
    );

    for (const candidate of candidates) {
      if (candidate.remainingBalance <= 0) continue;

      const amountMatched = Math.min(absAmount, candidate.remainingBalance);
      if (amountMatched <= 0) continue;

      const matchType: MatchType = candidate.isPrepayment
        ? 'prepayment'
        : amountMatched === candidate.remainingBalance && amountMatched === absAmount
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
   * Get candidate vouchers for a given entity.
   * For incoming: AR vouchers (via sales_invoice) + CustomerPrepayment vouchers.
   * For outgoing: AP vouchers (via expense).
   */
  private async getCandidateVouchers(
    entityId: number,
    isIncoming: boolean,
  ): Promise<CandidateVoucher[]> {
    const candidates: CandidateVoucher[] = [];

    if (isIncoming) {
      // AR vouchers from posted sales_invoices linked to this customer.
      const arVouchers = await this.db
        .selectFrom('sales_invoice')
        .innerJoin('voucher_line', 'voucher_line.voucher_id', 'sales_invoice.voucher_id')
        .innerJoin('account', 'account.id', 'voucher_line.account_id')
        .innerJoin('voucher', 'voucher.id', 'sales_invoice.voucher_id')
        .select('sales_invoice.voucher_id as voucher_id')
        .select('account.code as account_code')
        .select('voucher_line.base_amount')
        .select('sales_invoice.customer_id as entity_id')
        .select('voucher.tax_point_date')
        .where('sales_invoice.customer_id', '=', entityId)
        .where('sales_invoice.status', '=', 'posted')
        .where('sales_invoice.voucher_id', 'is not', null)
        .where('account.code', '=', 'AR')
        .where('voucher_line.is_debit', '=', 1)
        .execute();

      for (const v of arVouchers) {
        const voucherId = v.voucher_id;
        if (!voucherId) continue;
        const alreadyMatched = await this.getAlreadyMatched(voucherId);
        candidates.push({
          voucherId,
          accountCode: v.account_code,
          lineBaseAmount: v.base_amount,
          alreadyMatched,
          remainingBalance: v.base_amount - alreadyMatched,
          entityId: v.entity_id,
          taxPointDate: v.tax_point_date,
          isPrepayment: false,
        });
      }

      // Customer prepayment vouchers.
      const prepayVouchers = await this.db
        .selectFrom('voucher_line')
        .innerJoin('account', 'account.id', 'voucher_line.account_id')
        .innerJoin('voucher', 'voucher.id', 'voucher_line.voucher_id')
        .select('voucher_line.voucher_id as voucher_id')
        .select('account.code as account_code')
        .select('voucher_line.base_amount')
        .select('voucher.tax_point_date')
        .where('account.code', '=', 'CUSTOMER_PREPAYMENTS')
        .where('voucher_line.is_debit', '=', 0) // credit = liability increase
        .execute();

      for (const v of prepayVouchers) {
        const voucherId = v.voucher_id;
        if (!voucherId) continue;
        const alreadyMatched = await this.getAlreadyMatched(voucherId);
        candidates.push({
          voucherId,
          accountCode: v.account_code,
          lineBaseAmount: v.base_amount,
          alreadyMatched,
          remainingBalance: v.base_amount - alreadyMatched,
          entityId,
          taxPointDate: v.tax_point_date,
          isPrepayment: true,
        });
      }
    } else {
      // AP vouchers from posted expenses linked to this supplier.
      const apVouchers = await this.db
        .selectFrom('expense')
        .innerJoin('voucher_line', 'voucher_line.voucher_id', 'expense.voucher_id')
        .innerJoin('account', 'account.id', 'voucher_line.account_id')
        .innerJoin('voucher', 'voucher.id', 'expense.voucher_id')
        .select('expense.voucher_id as voucher_id')
        .select('account.code as account_code')
        .select('voucher_line.base_amount')
        .select('expense.supplier_id as entity_id')
        .select('voucher.tax_point_date')
        .where('expense.supplier_id', '=', entityId)
        .where('expense.status', '=', 'posted')
        .where('expense.voucher_id', 'is not', null)
        .where('account.code', '=', 'AP')
        .where('voucher_line.is_debit', '=', 0) // AP is a credit (liability)
        .execute();

      for (const v of apVouchers) {
        const voucherId = v.voucher_id;
        if (!voucherId) continue;
        const alreadyMatched = await this.getAlreadyMatched(voucherId);
        candidates.push({
          voucherId,
          accountCode: v.account_code,
          lineBaseAmount: v.base_amount,
          alreadyMatched,
          remainingBalance: v.base_amount - alreadyMatched,
          entityId: v.entity_id,
          taxPointDate: v.tax_point_date,
          isPrepayment: false,
        });
      }
    }

    return candidates;
  }

  /**
   * Get candidate vouchers by amount and date window (no entity filter).
   * Fallback when no invoice number or counterparty match is found.
   */
  private async getCandidateVouchersByAmountAndDate(
    _absAmount: number,
    transactionDate: string,
    isIncoming: boolean,
  ): Promise<CandidateVoucher[]> {
    const candidates: CandidateVoucher[] = [];
    const txDate = new Date(transactionDate);
    const windowStart = new Date(txDate);
    windowStart.setDate(windowStart.getDate() - DATE_WINDOW_DAYS);
    const windowEnd = new Date(txDate);
    windowEnd.setDate(windowEnd.getDate() + DATE_WINDOW_DAYS);

    const accountCode = isIncoming ? 'AR' : 'AP';
    const windowStartStr = windowStart.toISOString().slice(0, 10);
    const windowEndStr = windowEnd.toISOString().slice(0, 10);

    if (isIncoming) {
      const vouchers = await this.db
        .selectFrom('sales_invoice')
        .innerJoin('voucher_line', 'voucher_line.voucher_id', 'sales_invoice.voucher_id')
        .innerJoin('account', 'account.id', 'voucher_line.account_id')
        .innerJoin('voucher', 'voucher.id', 'sales_invoice.voucher_id')
        .select('sales_invoice.voucher_id as voucher_id')
        .select('account.code as account_code')
        .select('voucher_line.base_amount')
        .select('sales_invoice.customer_id as entity_id')
        .select('voucher.tax_point_date')
        .where('sales_invoice.status', '=', 'posted')
        .where('sales_invoice.voucher_id', 'is not', null)
        .where('account.code', '=', accountCode)
        .where('voucher_line.is_debit', '=', 1)
        .where('voucher.tax_point_date', '>=', windowStartStr)
        .where('voucher.tax_point_date', '<=', windowEndStr)
        .execute();

      for (const v of vouchers) {
        const voucherId = v.voucher_id;
        if (!voucherId) continue;
        const alreadyMatched = await this.getAlreadyMatched(voucherId);
        const remaining = v.base_amount - alreadyMatched;
        if (remaining <= 0) continue;

        candidates.push({
          voucherId,
          accountCode: v.account_code,
          lineBaseAmount: v.base_amount,
          alreadyMatched,
          remainingBalance: remaining,
          entityId: v.entity_id,
          taxPointDate: v.tax_point_date,
          isPrepayment: false,
        });
      }
    } else {
      const vouchers = await this.db
        .selectFrom('expense')
        .innerJoin('voucher_line', 'voucher_line.voucher_id', 'expense.voucher_id')
        .innerJoin('account', 'account.id', 'voucher_line.account_id')
        .innerJoin('voucher', 'voucher.id', 'expense.voucher_id')
        .select('expense.voucher_id as voucher_id')
        .select('account.code as account_code')
        .select('voucher_line.base_amount')
        .select('expense.supplier_id as entity_id')
        .select('voucher.tax_point_date')
        .where('expense.status', '=', 'posted')
        .where('expense.voucher_id', 'is not', null)
        .where('account.code', '=', accountCode)
        .where('voucher_line.is_debit', '=', 0) // AP is a credit (liability)
        .where('voucher.tax_point_date', '>=', windowStartStr)
        .where('voucher.tax_point_date', '<=', windowEndStr)
        .execute();

      for (const v of vouchers) {
        const voucherId = v.voucher_id;
        if (!voucherId) continue;
        const alreadyMatched = await this.getAlreadyMatched(voucherId);
        const remaining = v.base_amount - alreadyMatched;
        if (remaining <= 0) continue;

        candidates.push({
          voucherId,
          accountCode: v.account_code,
          lineBaseAmount: v.base_amount,
          alreadyMatched,
          remainingBalance: remaining,
          entityId: v.entity_id,
          taxPointDate: v.tax_point_date,
          isPrepayment: false,
        });
      }
    }

    return candidates;
  }

  /**
   * Get the total already-matched amount for a voucher from reconciliation_match.
   */
  private async getAlreadyMatched(voucherId: number): Promise<number> {
    const result = await this.db
      .selectFrom('reconciliation_match')
      .select((eb) => eb.fn.sum<number>('amount_matched').as('total'))
      .where('voucher_id', '=', voucherId)
      .executeTakeFirst();

    return result?.total ?? 0;
  }

  /**
   * Get the remaining unmatched balance for a voucher.
   */
  private async getRemainingVoucherBalance(voucherId: number): Promise<number> {
    // Get the total base_amount of AR/AP lines for this voucher.
    // AR lines are debits (is_debit=1), AP lines are credits (is_debit=0).
    const lineTotal = await this.db
      .selectFrom('voucher_line')
      .innerJoin('account', 'account.id', 'voucher_line.account_id')
      .select((eb) => eb.fn.sum<number>('voucher_line.base_amount').as('total'))
      .where('voucher_line.voucher_id', '=', voucherId)
      .where('account.code', 'in', ['AR', 'AP'])
      .executeTakeFirst();

    const totalBase = lineTotal?.total ?? 0;
    if (totalBase === 0) return 0;

    const alreadyMatched = await this.getAlreadyMatched(voucherId);
    return Math.max(0, totalBase - alreadyMatched);
  }

  /**
   * Execute proposed matches by inserting reconciliation_match records.
   * Does NOT auto-post settlement vouchers — only records the match.
   */
  async executeMatch(proposals: MatchProposal[]): Promise<ReconciliationMatchRecord[]> {
    if (proposals.length === 0) {
      throw new BadRequestException('No match proposals provided');
    }

    // Validate all proposals reference existing transactions and vouchers.
    const txnIds = [...new Set(proposals.map((p) => p.bankTransactionId))];
    const voucherIds = [...new Set(proposals.map((p) => p.voucherId))];

    for (const txnId of txnIds) {
      const txn = await this.transactionRepo.findById(txnId);
      if (!txn) {
        throw new NotFoundException(`Bank transaction ${txnId} not found`);
      }
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
    }

    return records;
  }
}
