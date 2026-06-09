import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely, Transaction } from 'kysely';
import { Database } from '../database/types';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { CandidateVoucher } from './reconciliation.types';

/**
 * The minimal Kysely executor this service reads through — satisfied by both a
 * top-level connection and an open {@link Transaction}. Recording a
 * **ReconciliationMatch** must re-check the outstanding balance and INSERT on
 * ONE connection (so a concurrent/repeated execute cannot over-match), so the
 * remaining-balance read accepts the caller's transaction.
 */
type DbExecutor = Kysely<Database> | Transaction<Database>;

/** Date window for amount+date candidate search (±7 days). */
const DATE_WINDOW_DAYS = 7;

/** The canonical AR/AP account codes that carry a receivable/payable outstanding. */
const AR_AP_CODES = ['AR', 'AP'];

/** The prepayment account codes whose undrawn credit is an outstanding to settle. */
const PREPAYMENT_CODES = ['CUSTOMER_PREPAYMENTS', 'SUPPLIER_PREPAYMENTS'];

/**
 * The base shape every candidate query selects before its remaining balance is
 * resolved. The join chain `business_object → voucher_line → account → voucher`
 * is owned here, so callers never re-write it.
 */
interface CandidateRow {
  voucher_id: number | null;
  account_code: string;
  base_amount: number;
  entity_id: number | null;
  tax_point_date: string;
}

/**
 * OutstandingVoucherService — the single source of "outstanding AR/AP candidate
 * Vouchers for reconciliation" plus their remaining balance.
 *
 * ── Why this is one deep module ──────────────────────────────────────────
 * The reconciliation engine needs to ask, in several phrasings, the SAME
 * question: "which posted Vouchers still carry an outstanding **Receivable**
 * (AR) / **Payable** (AP) — or an undrawn **prepayment** — that this bank line
 * could settle, and how much is left on each?" That question has exactly one
 * correct answer, but it was previously re-derived ~5 times inline:
 *
 *   - AR candidates for a **Customer** (counterparty signal)
 *   - **CUSTOMER_PREPAYMENTS** candidates (undrawn on-account credit)
 *   - AP candidates for a **Supplier** (counterparty signal)
 *   - AR candidates inside an amount+date window (fallback signal)
 *   - AP candidates inside an amount+date window (fallback signal)
 *
 * Each copy owned its own join chain, its own account-code / `is_debit`
 * polarity WHERE, AND its own remaining-balance maths. The five copies
 * disagreed on that last point: the inline `base_amount − alreadyMatched`
 * trusted that a single **VoucherLine** equals the voucher's AR/AP net — true
 * only for a one-line-per-code Voucher, wrong for a multi-line / contra Voucher.
 *
 * This module owns the join chain and the polarity once, exposes intent-named
 * reads, and routes EVERY remaining balance through {@link LedgerBalanceService}
 * `getVoucherNetBase` minus already-matched — the canonical
 * receivable/payable-outstanding primitive (ADR-0008: AR/AP live in the gap
 * between accrual and settlement). Prepayments (ADR-0011: a liability drawn
 * down by later invoices) share the same chain and remaining-balance path.
 */
@Injectable()
export class OutstandingVoucherService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly ledgerBalance: LedgerBalanceService,
  ) {}

  /**
   * Outstanding AR candidate Vouchers for one **Customer**, via posted
   * SalesInvoices. The AR line is a debit (an asset increase).
   */
  async findArCandidatesByCounterparty(
    customerId: number,
  ): Promise<CandidateVoucher[]> {
    const rows = await this.arBaseQuery()
      .where('sales_invoice.customer_id', '=', customerId)
      .execute();
    return this.toCandidates(rows, { isPrepayment: false });
  }

  /**
   * Outstanding AP candidate Vouchers for one **Supplier**, via posted
   * Expenses. The AP line is a credit (a liability increase).
   */
  async findApCandidatesByCounterparty(
    supplierId: number,
  ): Promise<CandidateVoucher[]> {
    const rows = await this.apBaseQuery()
      .where('expense.supplier_id', '=', supplierId)
      .execute();
    return this.toCandidates(rows, { isPrepayment: false });
  }

  /**
   * Undrawn **CUSTOMER_PREPAYMENTS** candidate Vouchers — on-account credit
   * received before an invoice exists (ADR-0011). The prepayment line is a
   * credit (a liability increase). The `entityId` is supplied by the caller
   * because a prepayment voucher is not joined to a business object that names
   * the counterparty here.
   */
  async findCustomerPrepaymentCandidates(
    entityId: number,
  ): Promise<CandidateVoucher[]> {
    const found = await this.db
      .selectFrom('voucher_line')
      .innerJoin('account', 'account.id', 'voucher_line.account_id')
      .innerJoin('voucher', 'voucher.id', 'voucher_line.voucher_id')
      .select('voucher_line.voucher_id as voucher_id')
      .select('account.code as account_code')
      .select('voucher_line.base_amount')
      .select('voucher.tax_point_date')
      .where('account.code', '=', 'CUSTOMER_PREPAYMENTS')
      .where('voucher_line.is_debit', '=', 0)
      .execute();
    const rows: CandidateRow[] = found.map((r) => ({
      ...r,
      entity_id: entityId,
    }));
    return this.toCandidates(rows, { isPrepayment: true });
  }

  /**
   * Outstanding AR candidate Vouchers whose tax-point date falls within
   * ±7 days of the bank line (fallback signal — no counterparty resolved).
   */
  async findArCandidatesByAmountAndDate(
    transactionDate: string,
  ): Promise<CandidateVoucher[]> {
    const { start, end } = this.dateWindow(transactionDate);
    const rows = await this.arBaseQuery()
      .where('voucher.tax_point_date', '>=', start)
      .where('voucher.tax_point_date', '<=', end)
      .execute();
    return this.toCandidates(rows, { isPrepayment: false });
  }

  /**
   * Outstanding AP candidate Vouchers whose tax-point date falls within
   * ±7 days of the bank line (fallback signal — no counterparty resolved).
   */
  async findApCandidatesByAmountAndDate(
    transactionDate: string,
  ): Promise<CandidateVoucher[]> {
    const { start, end } = this.dateWindow(transactionDate);
    const rows = await this.apBaseQuery()
      .where('voucher.tax_point_date', '>=', start)
      .where('voucher.tax_point_date', '<=', end)
      .execute();
    return this.toCandidates(rows, { isPrepayment: false });
  }

  /**
   * The remaining unmatched balance for an AR/AP Voucher — the path used by the
   * AR/AP candidate reads above and by direct invoice-number lookups. AR/AP net
   * base (canonical maths in {@link LedgerBalanceService}, netted by
   * debit/credit sign, abs'd) minus what reconciliation has already matched.
   * Never the single-line `base_amount`.
   */
  async getRemainingVoucherBalance(
    voucherId: number,
    executor: DbExecutor = this.db,
  ): Promise<number> {
    return this.remainingOverCodes(voucherId, AR_AP_CODES, executor);
  }

  /**
   * The remaining unmatched balance for a Voucher netted over the same
   * prepayment codes a prepayment candidate uses. Exposed so the
   * **ReconciliationMatch** execution path can re-check a prepayment draw-down's
   * outstanding inside its transaction, exactly as it does for AR/AP.
   */
  async getRemainingPrepaymentBalance(
    voucherId: number,
    executor: DbExecutor = this.db,
  ): Promise<number> {
    return this.remainingOverCodes(voucherId, PREPAYMENT_CODES, executor);
  }

  /**
   * The remaining unmatched balance for a Voucher netted over `accountCodes` —
   * the ONE primitive behind every candidate's remaining balance. AR/AP
   * candidates net over the AR/AP codes; a prepayment candidate nets over its
   * CUSTOMER_PREPAYMENTS / SUPPLIER_PREPAYMENTS line (its outstanding lives on
   * the prepayment account, not on AR/AP). Both go through the SAME
   * `getVoucherNetBase` − already-matched path, so no caller re-derives the
   * single-line `base_amount` discrepancy.
   */
  private async remainingOverCodes(
    voucherId: number,
    accountCodes: string[],
    executor: DbExecutor = this.db,
  ): Promise<number> {
    const totalBase = await this.ledgerBalance.getVoucherNetBase(
      voucherId,
      accountCodes,
      executor,
    );
    if (totalBase === 0) return 0;

    const alreadyMatched = await this.getAlreadyMatched(voucherId, executor);
    return Math.max(0, totalBase - alreadyMatched);
  }

  // ── Shared join chain ─────────────────────────────────────────────────

  /**
   * AR base query: posted SalesInvoice → its AR debit VoucherLine. Owns the
   * `business_object → voucher_line → account → voucher` chain and the AR
   * account-code / debit-polarity WHERE for every AR caller.
   */
  private arBaseQuery() {
    return this.db
      .selectFrom('sales_invoice')
      .innerJoin(
        'voucher_line',
        'voucher_line.voucher_id',
        'sales_invoice.voucher_id',
      )
      .innerJoin('account', 'account.id', 'voucher_line.account_id')
      .innerJoin('voucher', 'voucher.id', 'sales_invoice.voucher_id')
      .select('sales_invoice.voucher_id as voucher_id')
      .select('account.code as account_code')
      .select('voucher_line.base_amount')
      .select('sales_invoice.customer_id as entity_id')
      .select('voucher.tax_point_date')
      .where('sales_invoice.status', '=', 'posted')
      .where('sales_invoice.voucher_id', 'is not', null)
      .where('account.code', '=', 'AR')
      .where('voucher_line.is_debit', '=', 1);
  }

  /**
   * AP base query: posted Expense → its AP credit VoucherLine. Owns the same
   * chain and the AP account-code / credit-polarity WHERE for every AP caller.
   */
  private apBaseQuery() {
    return this.db
      .selectFrom('expense')
      .innerJoin(
        'voucher_line',
        'voucher_line.voucher_id',
        'expense.voucher_id',
      )
      .innerJoin('account', 'account.id', 'voucher_line.account_id')
      .innerJoin('voucher', 'voucher.id', 'expense.voucher_id')
      .select('expense.voucher_id as voucher_id')
      .select('account.code as account_code')
      .select('voucher_line.base_amount')
      .select('expense.supplier_id as entity_id')
      .select('voucher.tax_point_date')
      .where('expense.status', '=', 'posted')
      .where('expense.voucher_id', 'is not', null)
      .where('account.code', '=', 'AP')
      .where('voucher_line.is_debit', '=', 0);
  }

  /**
   * Map raw candidate rows to {@link CandidateVoucher}s, resolving each
   * remaining balance through the single canonical path. Rows whose Voucher id
   * is null are skipped (the `voucher_id is not null` WHERE makes this
   * defensive only).
   */
  private async toCandidates(
    rows: CandidateRow[],
    opts: { isPrepayment: boolean },
  ): Promise<CandidateVoucher[]> {
    const netCodes = opts.isPrepayment ? PREPAYMENT_CODES : AR_AP_CODES;
    const candidates: CandidateVoucher[] = [];
    for (const row of rows) {
      const voucherId = row.voucher_id;
      if (voucherId === null) continue;

      const alreadyMatched = await this.getAlreadyMatched(voucherId);
      const remainingBalance = await this.remainingOverCodes(
        voucherId,
        netCodes,
      );

      candidates.push({
        voucherId,
        accountCode: row.account_code,
        lineBaseAmount: row.base_amount,
        alreadyMatched,
        remainingBalance,
        entityId: row.entity_id,
        taxPointDate: row.tax_point_date,
        isPrepayment: opts.isPrepayment,
      });
    }
    return candidates;
  }

  /**
   * Total already-matched amount for a Voucher from reconciliation_match.
   */
  private async getAlreadyMatched(
    voucherId: number,
    executor: DbExecutor = this.db,
  ): Promise<number> {
    const result = await executor
      .selectFrom('reconciliation_match')
      .select((eb) => eb.fn.sum<number>('amount_matched').as('total'))
      .where('voucher_id', '=', voucherId)
      .executeTakeFirst();

    return result?.total ?? 0;
  }

  /** The inclusive ISO date window (±7 days) around a bank-line date. */
  private dateWindow(transactionDate: string): { start: string; end: string } {
    const txDate = new Date(transactionDate);
    const windowStart = new Date(txDate);
    windowStart.setDate(windowStart.getDate() - DATE_WINDOW_DAYS);
    const windowEnd = new Date(txDate);
    windowEnd.setDate(windowEnd.getDate() + DATE_WINDOW_DAYS);
    return {
      start: windowStart.toISOString().slice(0, 10),
      end: windowEnd.toISOString().slice(0, 10),
    };
  }
}
