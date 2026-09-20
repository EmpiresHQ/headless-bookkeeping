import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely, Transaction } from 'kysely';
import { Database } from '../database/types';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { CandidateVoucher } from './reconciliation.types';
import { PrepaymentAllocationRepository } from './prepayment-allocation.repository';

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
 * The business-object statuses whose Voucher can still carry an outstanding.
 *
 * `posted` is the ordinary case. `reversed` is here because a FINANCIAL
 * correction (ADR-0009) leaves the object terminal-`reversed` and RE-POINTED
 * at its corrected Voucher: the obligation did not disappear, it was restated,
 * and the replacement is what the counterparty owes. Including the status
 * alone would also re-offer CANCELLED objects, so it never stands alone — it
 * is always paired with {@link voucherNotReversed}, which is the actual
 * policy: offer the object's voucher only while that voucher still stands. A
 * cancelled object points at a voucher a counter-voucher reversed, so it stays
 * out; a corrected one points at the live replacement, so it comes back in.
 */
const LIVE_OBJECT_STATUSES = ['posted', 'reversed'];

/**
 * Which side of an outstanding a Voucher sits on. It picks BOTH the account
 * codes to net over and how prepayment allocations consume it: an `arap`
 * Voucher is the TARGET of allocations, a `prepayment` Voucher their SOURCE.
 */
type OutstandingSide = 'arap' | 'prepayment';

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
 * One business object's subledger position: what is still collectible/payable
 * on it, and what has been settled BEYOND it (a refund owed back).
 */
export interface OpenItemBalance {
  voucherId: number;
  objectType: 'sales_invoice' | 'expense';
  objectId: number;
  objectLabel: string;
  entityId: number | null;
  /** Still collectible (AR) / payable (AP). Never negative. */
  remaining: number;
  /** Settled beyond the obligation — owed back. Never negative. */
  surplus: number;
  /** True when the object's Voucher has been reversed (cancelled). */
  cancelled: boolean;
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
 * `getVoucherNetBase` minus every linked settlement — cash matched, advance
 * allocated (issue #201) and credit-noted (issue #202) — the canonical
 * receivable/payable-outstanding primitive (ADR-0008: AR/AP live in the gap
 * between accrual and settlement). Prepayments (ADR-0011: a liability drawn
 * down by later invoices) share the same chain and remaining-balance path.
 */
@Injectable()
export class OutstandingVoucherService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly ledgerBalance: LedgerBalanceService,
    private readonly allocations: PrepaymentAllocationRepository,
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
   * Undrawn **CUSTOMER_PREPAYMENTS** candidate Vouchers for ONE **Customer** —
   * on-account credit received before an invoice exists (ADR-0011).
   *
   * Ownership is read from the advance record written when the prepayment was
   * created (issue #201), never stamped on from the caller: before that record
   * existed this query returned EVERY prepayment voucher in the ledger with the
   * requested customer's id injected into each row, so a bank line for customer
   * X was offered another customer's advance. An advance whose owner or balance
   * is unresolved, or whose own voucher has been reversed, is not a candidate.
   */
  async findCustomerPrepaymentCandidates(
    entityId: number,
  ): Promise<CandidateVoucher[]> {
    const found = await this.db
      .selectFrom('prepayment_advance')
      .innerJoin('voucher', 'voucher.id', 'prepayment_advance.voucher_id')
      .select('prepayment_advance.voucher_id as voucher_id')
      .select('prepayment_advance.account_code as account_code')
      .select('prepayment_advance.original_base_amount as base_amount')
      .select('prepayment_advance.entity_id as entity_id')
      .select('voucher.tax_point_date as tax_point_date')
      .where('prepayment_advance.kind', '=', 'customer')
      .where('prepayment_advance.entity_id', '=', entityId)
      .where('prepayment_advance.needs_review', '=', 0)
      .execute();

    const rows: CandidateRow[] = [];
    for (const row of found) {
      const cancelled = await this.allocations.isVoucherReversed(
        row.voucher_id,
      );
      if (!cancelled) rows.push(row);
    }
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
   * ALL outstanding AR candidate Vouchers (no counterparty / date filter) — the
   * pool a manual match picks from. AR only (incoming settlements).
   */
  async findAllArCandidates(): Promise<CandidateVoucher[]> {
    const rows = await this.arBaseQuery().execute();
    return this.toCandidates(rows, { isPrepayment: false });
  }

  /**
   * ALL outstanding AP candidate Vouchers (no counterparty / date filter) — the
   * pool a manual match picks from. AP only (outgoing settlements).
   */
  async findAllApCandidates(): Promise<CandidateVoucher[]> {
    const rows = await this.apBaseQuery().execute();
    return this.toCandidates(rows, { isPrepayment: false });
  }

  /**
   * The remaining unmatched balance for an AR/AP Voucher — the path used by the
   * AR/AP candidate reads above and by direct invoice-number lookups. AR/AP net
   * base (canonical maths in {@link LedgerBalanceService}, netted by
   * debit/credit sign, abs'd) minus EVERY linked settlement: cash matched,
   * advance allocated, and credit-noted. Never the single-line `base_amount`.
   */
  async getRemainingVoucherBalance(
    voucherId: number,
    executor: DbExecutor = this.db,
  ): Promise<number> {
    return this.remainingOverCodes(voucherId, 'arap', executor);
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
    return this.remainingOverCodes(voucherId, 'prepayment', executor);
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
    side: OutstandingSide,
    executor: DbExecutor = this.db,
  ): Promise<number> {
    return Math.max(0, await this.netOverCodes(voucherId, side, executor));
  }

  /**
   * What settlement has taken BEYOND the outstanding — the part
   * {@link remainingOverCodes} clips to zero, surfaced rather than swallowed.
   *
   * It is not noise: a **Credit note** issued AFTER the invoice was paid leaves
   * the counterparty over-settled (the AR control goes negative — money owed
   * BACK, a refund), and an operator repair can over-match. Nothing is left to
   * collect, so the outstanding is correctly zero and the invoice is not
   * offered; but "zero outstanding" and "settled exactly" are different facts,
   * and only this one makes an AR/AP control account reconcile: the control
   * balance equals Σ open items − Σ surplus (plus any cash whose settlement
   * voucher was never posted — see ReconciliationService listUnpostedSettlements).
   */
  async getSettlementSurplus(
    voucherId: number,
    executor: DbExecutor = this.db,
  ): Promise<number> {
    return Math.max(0, -(await this.netOverCodes(voucherId, 'arap', executor)));
  }

  /**
   * The SIGNED outstanding: netted AR/AP (or prepayment) base minus every
   * linked settlement. Negative means over-settled. The one place the terms
   * are assembled; the public reads clip it in their own direction.
   *
   * A Voucher that a posted counter-voucher REVERSES has no outstanding at
   * all — the ledger fact that its economic event was undone. That covers both
   * a cancelled object (reversal-only correction) and the superseded original
   * of a corrected one (ADR-0009), and it is what stops a stale draft or a
   * direct call from settling a voucher that no longer stands. It is the same
   * `reverses_id` rule that releases an allocation and a credit note, applied
   * to the settled item itself.
   */
  private async netOverCodes(
    voucherId: number,
    side: OutstandingSide,
    executor: DbExecutor = this.db,
  ): Promise<number> {
    const accountCodes = side === 'arap' ? AR_AP_CODES : PREPAYMENT_CODES;
    const totalBase = await this.ledgerBalance.getVoucherNetBase(
      voucherId,
      accountCodes,
      executor,
    );
    if (totalBase === 0) return 0;

    // A Voucher a posted counter-voucher REVERSES no longer carries an
    // obligation — but the settlements taken against it DO NOT vanish with it.
    // Cancelling a paid invoice leaves the cash (and any credit or advance)
    // exactly where it was: nothing is collectible, and what was taken is now
    // owed BACK. Zeroing only the obligation keeps that residual visible as a
    // surplus instead of erasing money the counterparty is due.
    const reversed = await this.allocations.isVoucherReversed(
      voucherId,
      executor,
    );
    const obligation = reversed ? 0 : totalBase;

    const alreadyMatched = await this.getAlreadyMatched(voucherId, executor);
    const allocated = await this.getAlreadyAllocated(voucherId, side, executor);
    const credited = await this.getAlreadyCredited(voucherId, side, executor);
    return obligation - alreadyMatched - allocated - credited;
  }

  /**
   * Base amount of this AR/AP Voucher's outstanding already cancelled by POSTED
   * **Credit note**s against its business object (issue #202) — the THIRD way an
   * outstanding is consumed, beside cash (`reconciliation_match`) and an advance
   * (`prepayment_allocation`).
   *
   * A credit note is its own document with its own Voucher (never a reversal of
   * the original, see {@link CreditNotesService}), so the credited amount is
   * invisible to `getVoucherNetBase` of the INVOICE voucher: the ledger AR of a
   * fully credited invoice is zero while its outstanding read the full gross,
   * and reconciliation kept offering the invoice as collectible.
   *
   * The amount taken is the credit Voucher's OWN AR/AP net base — the real
   * base-currency effect it posted, not the credit note's `gross_amount` (which
   * is denominated in the document currency). A credit note whose Voucher has
   * been reversed releases its credit, read from the ledger through the same
   * `reverses_id` rule that releases a prepayment allocation, so every
   * settlement type reverses by one rule.
   *
   * Only the `arap` side can be credited: a credit note always names a
   * `sales_invoice` or an `expense`, never a prepayment.
   */
  private async getAlreadyCredited(
    voucherId: number,
    side: OutstandingSide,
    executor: DbExecutor,
  ): Promise<number> {
    if (side !== 'arap') return 0;

    const notes = await executor
      .selectFrom('credit_note')
      .select('credit_note.voucher_id as voucher_id')
      .where('credit_note.status', '=', 'posted')
      .where('credit_note.voucher_id', 'is not', null)
      .where((eb) =>
        eb.or([
          eb.and([
            eb('credit_note.credits_object_type', '=', 'sales_invoice'),
            eb.exists(
              eb
                .selectFrom('sales_invoice')
                .select('sales_invoice.id')
                .whereRef(
                  'sales_invoice.id',
                  '=',
                  'credit_note.credits_object_id',
                )
                .where('sales_invoice.voucher_id', '=', voucherId),
            ),
          ]),
          eb.and([
            eb('credit_note.credits_object_type', '=', 'expense'),
            eb.exists(
              eb
                .selectFrom('expense')
                .select('expense.id')
                .whereRef('expense.id', '=', 'credit_note.credits_object_id')
                .where('expense.voucher_id', '=', voucherId),
            ),
          ]),
        ]),
      )
      .execute();

    let total = 0;
    for (const note of notes) {
      const creditVoucherId = note.voucher_id;
      if (creditVoucherId === null) continue;
      const released = await this.allocations.isVoucherReversed(
        creditVoucherId,
        executor,
      );
      if (released) continue;
      total += await this.ledgerBalance.getVoucherNetBase(
        creditVoucherId,
        AR_AP_CODES,
        executor,
      );
    }
    return total;
  }

  /**
   * Total still-active prepayment allocation against a Voucher — the OTHER way
   * an outstanding is consumed (issue #201). Folded in HERE, in the canonical
   * primitive, so a receivable a prepayment already relieved cannot also be
   * cash-matched in full by {@link ReconciliationService} `activateMatch`, and
   * an advance already drawn down cannot be re-offered as undrawn credit.
   *
   * Which side the Voucher is on decides how it is consumed: an AR/AP Voucher
   * is the TARGET of allocations (`invoice_voucher_id`), a prepayment Voucher
   * is their SOURCE (its advance record). Exactly one of the two applies, so
   * nothing is subtracted twice.
   */
  private async getAlreadyAllocated(
    voucherId: number,
    side: OutstandingSide,
    executor: DbExecutor,
  ): Promise<number> {
    return side === 'arap'
      ? this.allocations.activeAllocatedForInvoice(voucherId, executor)
      : this.allocations.activeAllocatedForAdvanceVoucher(voucherId, executor);
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
      .where('sales_invoice.status', 'in', LIVE_OBJECT_STATUSES)
      .where('sales_invoice.voucher_id', 'is not', null)
      .where('sales_invoice.voucher_id', 'not in', this.reversedVoucherIds())
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
      .where('expense.status', 'in', LIVE_OBJECT_STATUSES)
      .where('expense.voucher_id', 'is not', null)
      .where('expense.voucher_id', 'not in', this.reversedVoucherIds())
      .where('account.code', '=', 'AP')
      .where('voucher_line.is_debit', '=', 0);
  }

  /**
   * Every AR/AP business object's Voucher with what is still OPEN on it and
   * what has been over-settled on it — including the objects the candidate
   * reads deliberately hide (a cancelled invoice is never collectible again,
   * but the payment taken against it is still owed back).
   *
   * This is the subledger side of the control-account reconciliation: the AR
   * control balance equals `Σ remaining − Σ surplus` over these rows, plus any
   * cash whose settlement voucher was never posted
   * ({@link ReconciliationService.listUnpostedSettlements}). Rows where both
   * numbers are zero are omitted — a fully settled invoice is not an open item.
   */
  async listOpenItemBalances(): Promise<OpenItemBalance[]> {
    const invoices = await this.db
      .selectFrom('sales_invoice')
      .select('id as object_id')
      .select('voucher_id')
      .select('customer_id as entity_id')
      .select('invoice_number as label')
      .where('voucher_id', 'is not', null)
      .where('status', 'in', LIVE_OBJECT_STATUSES)
      .execute();
    const expenses = await this.db
      .selectFrom('expense')
      .select('id as object_id')
      .select('voucher_id')
      .select('supplier_id as entity_id')
      .select('tax_point_date as label')
      .where('voucher_id', 'is not', null)
      .where('status', 'in', LIVE_OBJECT_STATUSES)
      .execute();

    const rows: OpenItemBalance[] = [];
    for (const row of [
      ...invoices.map((r) => ({ ...r, objectType: 'sales_invoice' as const })),
      ...expenses.map((r) => ({ ...r, objectType: 'expense' as const })),
    ]) {
      const voucherId = row.voucher_id;
      if (voucherId === null) continue;
      const remaining = await this.remainingOverCodes(voucherId, 'arap');
      const surplus = await this.getSettlementSurplus(voucherId);
      if (remaining === 0 && surplus === 0) continue;
      rows.push({
        voucherId,
        objectType: row.objectType,
        objectId: row.object_id,
        objectLabel: row.label,
        entityId: row.entity_id,
        remaining,
        surplus,
        cancelled: await this.allocations.isVoucherReversed(voucherId),
      });
    }
    return rows;
  }

  /**
   * The ids of every Voucher a POSTED counter-voucher reverses — the
   * live-voucher predicate both candidate chains filter on. The same
   * `reverses_id` rule the allocation and credit-note releases read, so one
   * ledger fact decides everywhere whether a posting still stands.
   *
   * The `reverses_id is not null` filter is required, not cosmetic: a NULL
   * inside a `NOT IN` set makes the whole predicate unknown and would drop
   * every candidate row.
   */
  private reversedVoucherIds() {
    return this.db
      .selectFrom('voucher as rev')
      .select('rev.reverses_id')
      .where('rev.posted_at', 'is not', null)
      .where('rev.reverses_id', 'is not', null);
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
    const side: OutstandingSide = opts.isPrepayment ? 'prepayment' : 'arap';
    const candidates: CandidateVoucher[] = [];
    for (const row of rows) {
      const voucherId = row.voucher_id;
      if (voucherId === null) continue;

      const alreadyMatched = await this.getAlreadyMatched(voucherId);
      const remainingBalance = await this.remainingOverCodes(voucherId, side);

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
   *
   * Only `active` matches count: a `draft` match is staged behind an Approval
   * and must NOT reduce the outstanding AR/AP until a human promotes it. This is
   * the single seam that keeps a draft from silently settling a receivable.
   */
  private async getAlreadyMatched(
    voucherId: number,
    executor: DbExecutor = this.db,
  ): Promise<number> {
    const result = await executor
      .selectFrom('reconciliation_match')
      .select((eb) => eb.fn.sum<number>('amount_matched').as('total'))
      .where('voucher_id', '=', voucherId)
      .where('status', '=', 'active')
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
