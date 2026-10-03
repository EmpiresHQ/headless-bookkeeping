import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely, Transaction, ExpressionBuilder } from 'kysely';
import { Database } from '../database/types';

/**
 * The minimal Kysely executor this repository reads/writes through — satisfied
 * by both a top-level connection and an open {@link Transaction}. Every
 * allocation read accepts the caller's transaction so a draw-down can re-check
 * the available balance and INSERT on ONE connection (better-sqlite3 forbids a
 * top-level read inside an open transaction anyway).
 */
export type DbExecutor = Kysely<Database> | Transaction<Database>;

/**
 * What an advance IS, for tax (issue #213). Recorded, never inferred from a
 * description: `taxable_supply` is an advance on an identified supply whose tax
 * point is the receipt, `non_taxable_deposit` is a gross liability that
 * declares nothing, and `unresolved` is money that arrived unclassified — still
 * recorded, but HELD (neither allocatable nor settleable) until someone says
 * what it is.
 */
export type AdvanceTaxTreatment =
  | 'taxable_supply'
  | 'non_taxable_deposit'
  | 'unresolved';

/**
 * The tax facts of one advance (issue #213), frozen as at its receipt.
 *
 * `grossBaseAmount` is the money received; `netBaseAmount` is the liability leg
 * the ledger carries; `vatBaseAmount` is the output VAT declared at the
 * receipt. For a deposit or an unresolved receipt the gross IS the net and the
 * VAT is zero — that is what those books say.
 */
export interface AdvanceTaxFacts {
  treatment: AdvanceTaxTreatment;
  vatCode: string | null;
  /** Rate in force on the receipt date, in per mille (240 = 24%). */
  vatRatePermille: number | null;
  grossBaseAmount: number;
  vatBaseAmount: number;
  supplyDescription: string | null;
  advanceDocumentNumber: string | null;
  /** The advance tax point — the day the payment was received. */
  advanceTaxPointDate: string | null;
  /** Set when this advance was reclassified and replaced by another. */
  supersededByAdvanceId: number | null;
}

/** A persisted advance (issue #201): the owner + provenance of one advance voucher. */
export interface PrepaymentAdvance {
  id: number;
  voucherId: number;
  kind: 'customer' | 'supplier';
  accountCode: string;
  entityId: number | null;
  bankTransactionId: number | null;
  originalBaseAmount: number;
  currency: string;
  needsReview: boolean;
  origin: string;
  /** Issue #213 — what the money is, and the VAT it already declared. */
  tax: AdvanceTaxFacts;
}

/** Values for a new allocation row, written inside the draw-down's transaction. */
export interface NewAllocation {
  advanceId: number;
  invoiceVoucherId: number;
  entityId: number | null;
  baseAmount: number;
  currency: string;
  allocationVoucherId: number;
  origin: string;
  /** Advance VAT this draw-down releases (issue #213); 0 when none was declared. */
  vatBaseAmount?: number;
}

/** One refund of an advance, written inside the refund's own transaction. */
export interface NewRefund {
  advanceId: number;
  voucherId: number;
  bankTransactionId: number;
  netBaseAmount: number;
  vatBaseAmount: number;
  currency: string;
  /** The cancellation/credit document the fiscal relief is taken under. */
  creditReference: string;
  reason: string;
  refundDate: string;
}

/** One customer advance still HELD as unclassified in a period (issue #213). */
export interface HeldAdvanceReceipt {
  advanceId: number;
  voucherId: number;
  voucherNumber: string;
  entityId: number | null;
  grossBaseAmount: number;
  currency: string;
  receiptDate: string;
}

/** A historical draw-down voucher with no allocation record yet. */
export interface UnlinkedDrawDown {
  voucherId: number;
  baseAmount: number;
  currency: string;
}

const PREPAYMENT_ACCOUNT: Record<'customer' | 'supplier', string> = {
  customer: 'CUSTOMER_PREPAYMENTS',
  supplier: 'SUPPLIER_PREPAYMENTS',
};

/** The AR/AP side a kind's draw-down relieves. */
const RELIEVED_ACCOUNT: Record<'customer' | 'supplier', string> = {
  customer: 'AR',
  supplier: 'AP',
};

/** The is_debit polarity a kind's prepayment account takes in a DRAW-DOWN. */
const DRAW_DOWN_DEBIT: Record<'customer' | 'supplier', number> = {
  customer: 1,
  supplier: 0,
};

/**
 * PrepaymentAllocationRepository — the single owner of the advance/allocation
 * records behind a prepayment's remaining balance (issue #201).
 *
 * The one rule every caller depends on: an allocation is ACTIVE until its
 * allocation Voucher is reversed. "Reversed" is read from the ledger
 * (`voucher.reverses_id` on a posted counter-voucher), never from a mirrored
 * status column — so a reversal posted through ANY path releases exactly that
 * allocation and leaves every other one untouched. Both the prepayment service
 * and {@link OutstandingVoucherService} net through here, so neither can
 * re-derive a drawn-down total by scanning the ledger for draw-down-SHAPED
 * vouchers (the #201 bug: that sum is global, not per-advance).
 */
@Injectable()
export class PrepaymentAllocationRepository {
  constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

  /** The advance record for a posted advance voucher, or null if unregistered. */
  async findAdvanceByVoucherId(
    voucherId: number,
    executor: DbExecutor = this.db,
  ): Promise<PrepaymentAdvance | null> {
    const row = await executor
      .selectFrom('prepayment_advance')
      .selectAll()
      .where('voucher_id', '=', voucherId)
      .executeTakeFirst();
    return row ? toAdvance(row) : null;
  }

  /**
   * Base amount consumed from ONE advance by its own still-active allocations.
   * This is the figure that makes advance A and advance B independent.
   */
  async activeAllocatedForAdvance(
    advanceId: number,
    executor: DbExecutor = this.db,
  ): Promise<number> {
    const row = await executor
      .selectFrom('prepayment_allocation')
      .select((eb) => eb.fn.sum<number>('base_amount').as('total'))
      .where('advance_id', '=', advanceId)
      .where((eb) => notReversed(eb))
      .executeTakeFirst();
    return row?.total ?? 0;
  }

  /**
   * Amount already allocated AGAINST one invoice voucher by still-active
   * allocations — the term that keeps a later draw-down, or a later cash match,
   * from settling a receivable a prepayment has already relieved.
   *
   * The invoice is relieved GROSS: `base_amount` is the advance liability the
   * draw-down consumed and `vat_base_amount` the advance VAT it released
   * (issue #213), and the receivable was cleared by their sum. Splitting them
   * is what lets the SAME allocation consume the advance by its net and the
   * invoice by its gross without either side double-counting. A pre-#213 row
   * carries `vat_base_amount = 0`, so it reads exactly as it always did.
   */
  async activeAllocatedForInvoice(
    invoiceVoucherId: number,
    executor: DbExecutor = this.db,
  ): Promise<number> {
    const row = await executor
      .selectFrom('prepayment_allocation')
      .select((eb) =>
        eb.fn
          .sum<number>(
            eb(eb.ref('base_amount'), '+', eb.ref('vat_base_amount')),
          )
          .as('total'),
      )
      .where('invoice_voucher_id', '=', invoiceVoucherId)
      .where((eb) => notReversed(eb))
      .executeTakeFirst();
    return row?.total ?? 0;
  }

  /**
   * Base amount consumed from the advance registered on ONE advance voucher.
   * Returns 0 when the voucher carries no advance record — the caller decides
   * what an unregistered prepayment voucher means (it is never simply "fully
   * available").
   */
  async activeAllocatedForAdvanceVoucher(
    advanceVoucherId: number,
    executor: DbExecutor = this.db,
  ): Promise<number> {
    const row = await executor
      .selectFrom('prepayment_allocation')
      .innerJoin(
        'prepayment_advance',
        'prepayment_advance.id',
        'prepayment_allocation.advance_id',
      )
      .select((eb) =>
        eb.fn.sum<number>('prepayment_allocation.base_amount').as('total'),
      )
      .where('prepayment_advance.voucher_id', '=', advanceVoucherId)
      .where((eb) => notReversed(eb))
      .executeTakeFirst();

    // Money REFUNDED is gone too (issue #213). Its voucher relieves the
    // prepayment account on a voucher of its own, exactly as an allocation
    // does, so the advance's own netted leg cannot see it: without this term
    // the credit would still be offered — to a draw-down, and to a bank match
    // — after it was paid back.
    const refunded = await executor
      .selectFrom('prepayment_refund')
      .innerJoin(
        'prepayment_advance',
        'prepayment_advance.id',
        'prepayment_refund.advance_id',
      )
      .select([
        'prepayment_refund.voucher_id as voucher_id',
        'prepayment_refund.net_base_amount as net_base_amount',
      ])
      .where('prepayment_advance.voucher_id', '=', advanceVoucherId)
      .execute();

    let refundedTotal = 0;
    for (const r of refunded) {
      // Only a PROVED-complete reversal of the refund gives the credit back.
      if ((await this.classifyReversal(r.voucher_id, executor)) !== 'released')
        refundedTotal += r.net_base_amount;
    }

    return (row?.total ?? 0) + refundedTotal;
  }

  /**
   * True when a POSTED counter-voucher reverses this voucher. Used for both
   * halves of the same rule: a reversed allocation voucher releases its
   * allocation, and a reversed ADVANCE voucher cancels the advance — cancelled
   * credit never becomes available to allocate again.
   */
  async isVoucherReversed(
    voucherId: number,
    executor: DbExecutor = this.db,
  ): Promise<boolean> {
    const row = await executor
      .selectFrom('voucher')
      .select('id')
      .where('reverses_id', '=', voucherId)
      .where('posted_at', 'is not', null)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** The allocation evidenced by one allocation voucher, if any. */
  async findAllocationByVoucherId(
    allocationVoucherId: number,
    executor: DbExecutor = this.db,
  ): Promise<{ id: number; advanceId: number } | null> {
    const row = await executor
      .selectFrom('prepayment_allocation')
      .select(['id', 'advance_id'])
      .where('allocation_voucher_id', '=', allocationVoucherId)
      .executeTakeFirst();
    return row ? { id: row.id, advanceId: row.advance_id } : null;
  }

  /**
   * Historical draw-down vouchers of one kind that carry NO allocation record —
   * the exact set whose existence makes that kind's advances unverifiable. A
   * draw-down voucher: the kind's prepayment account moving in its draw-down
   * direction on a voucher that also carries the relieved AR/AP leg and is not
   * itself a counter-voucher.
   */
  async listUnlinkedDrawDowns(
    kind: 'customer' | 'supplier',
    executor: DbExecutor = this.db,
  ): Promise<UnlinkedDrawDown[]> {
    const rows = await executor
      .selectFrom('voucher_line')
      .innerJoin('account', 'account.id', 'voucher_line.account_id')
      .innerJoin('voucher', 'voucher.id', 'voucher_line.voucher_id')
      .select([
        'voucher_line.voucher_id as voucher_id',
        'voucher_line.base_amount as base_amount',
        'voucher_line.currency as currency',
      ])
      .where('account.code', '=', PREPAYMENT_ACCOUNT[kind])
      .where('voucher_line.is_debit', '=', DRAW_DOWN_DEBIT[kind])
      .where('voucher.reverses_id', 'is', null)
      .where('voucher.posted_at', 'is not', null)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('voucher_line as arap')
            .innerJoin('account as ara', 'ara.id', 'arap.account_id')
            .select('arap.id')
            .whereRef('arap.voucher_id', '=', 'voucher_line.voucher_id')
            .where('ara.code', '=', RELIEVED_ACCOUNT[kind]),
        ),
      )
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('prepayment_allocation as pa')
              .select('pa.id')
              .whereRef(
                'pa.allocation_voucher_id',
                '=',
                'voucher_line.voucher_id',
              ),
          ),
        ),
      )
      .execute();

    return rows.map((r) => ({
      voucherId: r.voucher_id,
      baseAmount: r.base_amount,
      currency: r.currency,
    }));
  }

  /** Every allocation recorded against one advance, released ones included. */
  async listAllocationsForAdvance(
    advanceId: number,
    executor: DbExecutor = this.db,
  ): Promise<
    {
      id: number;
      invoiceVoucherId: number;
      allocationVoucherId: number;
      entityId: number | null;
      baseAmount: number;
    }[]
  > {
    const rows = await executor
      .selectFrom('prepayment_allocation')
      .select([
        'id',
        'invoice_voucher_id',
        'allocation_voucher_id',
        'entity_id',
        'base_amount',
      ])
      .where('advance_id', '=', advanceId)
      .orderBy('id')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      invoiceVoucherId: r.invoice_voucher_id,
      allocationVoucherId: r.allocation_voucher_id,
      entityId: r.entity_id,
      baseAmount: r.base_amount,
    }));
  }

  /**
   * Stamp the now-known counterparty onto an advance's allocations that carry
   * none (backfilled rows), so the allocation record is complete once its
   * advance is resolved.
   */
  async setAllocationEntityForAdvance(
    advanceId: number,
    entityId: number,
    executor: DbExecutor = this.db,
  ): Promise<void> {
    await executor
      .updateTable('prepayment_allocation')
      .set({ entity_id: entityId })
      .where('advance_id', '=', advanceId)
      .where('entity_id', 'is', null)
      .execute();
  }

  /** Insert one allocation — always inside the caller's own transaction. */
  async insertAllocation(
    values: NewAllocation,
    executor: DbExecutor,
  ): Promise<number> {
    const inserted = await executor
      .insertInto('prepayment_allocation')
      .values({
        advance_id: values.advanceId,
        invoice_voucher_id: values.invoiceVoucherId,
        entity_id: values.entityId,
        base_amount: values.baseAmount,
        currency: values.currency,
        allocation_voucher_id: values.allocationVoucherId,
        vat_base_amount: values.vatBaseAmount ?? 0,
        origin: values.origin,
        created_at: Math.floor(Date.now() / 1000),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return inserted.id;
  }

  /** Register a new advance — always inside the creation's own transaction. */
  async insertAdvance(
    values: Omit<PrepaymentAdvance, 'id'>,
    executor: DbExecutor,
  ): Promise<number> {
    const inserted = await executor
      .insertInto('prepayment_advance')
      .values({
        voucher_id: values.voucherId,
        kind: values.kind,
        account_code: values.accountCode,
        entity_id: values.entityId,
        bank_transaction_id: values.bankTransactionId,
        original_base_amount: values.originalBaseAmount,
        currency: values.currency,
        needs_review: values.needsReview ? 1 : 0,
        origin: values.origin,
        created_at: Math.floor(Date.now() / 1000),
        tax_treatment: values.tax.treatment,
        vat_code: values.tax.vatCode,
        vat_rate_permille: values.tax.vatRatePermille,
        gross_base_amount: values.tax.grossBaseAmount,
        vat_base_amount: values.tax.vatBaseAmount,
        supply_description: values.tax.supplyDescription,
        advance_document_number: values.tax.advanceDocumentNumber,
        advance_tax_point_date: values.tax.advanceTaxPointDate,
        superseded_by_advance_id: values.tax.supersededByAdvanceId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return inserted.id;
  }

  /**
   * What a counter-voucher chain PROVES about one voucher (issue #213).
   *
   * `voucher.reverses_id` is a pointer, not evidence of how much was undone:
   * the schema permits a counter-voucher that mirrors only part of a voucher,
   * and a reversal that is itself reversed. Money the tax authority has already
   * been told about must not be restored to an advance's spendable VAT
   * allowance on the strength of a pointer, so the chain is PROVED against the
   * ledger:
   *
   *  - `active`    — nothing posted reverses it.
   *  - `released`  — the posted counter-vouchers mirror it EXACTLY, account for
   *                  account, signed base for signed base. This is what the
   *                  kernel's own reversal path posts (ADR-0009), so the normal
   *                  case is proved rather than assumed.
   *  - `ambiguous` — anything else: a partial counter-voucher, a mirror that
   *                  does not balance out, or a reversal that was itself
   *                  reversed. The caller HOLDS; nothing is guessed either way.
   *
   * This is deliberately narrower than the repository's `notReversed` SQL
   * predicate, which the shared outstanding-balance primitive uses for base
   * amounts. That predicate is not changed here — it is the #201/#202
   * convention the whole reconciliation path is built on — but no VAT-bearing
   * write is allowed to proceed while this proof is missing (see
   * {@link listUnprovenReversalChains}).
   */
  async classifyReversal(
    voucherId: number,
    executor: DbExecutor = this.db,
  ): Promise<'active' | 'released' | 'ambiguous'> {
    const reversals = await executor
      .selectFrom('voucher')
      .select('id')
      .where('reverses_id', '=', voucherId)
      .where('posted_at', 'is not', null)
      .execute();
    if (reversals.length === 0) return 'active';

    // A reversal that was itself reversed says nothing definite about the
    // original — the kernel never posts that shape, so it is held, not decoded.
    for (const r of reversals) {
      const undone = await executor
        .selectFrom('voucher')
        .select('id')
        .where('reverses_id', '=', r.id)
        .where('posted_at', 'is not', null)
        .executeTakeFirst();
      if (undone) return 'ambiguous';
    }

    const original = await this.signedBaseByAccount([voucherId], executor);
    const mirror = await this.signedBaseByAccount(
      reversals.map((r) => r.id),
      executor,
    );

    const accounts = new Set([...original.keys(), ...mirror.keys()]);
    for (const account of accounts) {
      if ((original.get(account) ?? 0) + (mirror.get(account) ?? 0) !== 0) {
        return 'ambiguous';
      }
    }
    return 'released';
  }

  /** Signed base (debit positive) per account id over the named vouchers. */
  private async signedBaseByAccount(
    voucherIds: number[],
    executor: DbExecutor,
  ): Promise<Map<number, number>> {
    const rows = await executor
      .selectFrom('voucher_line')
      .select(['account_id', 'base_amount', 'is_debit'])
      .where('voucher_id', 'in', voucherIds)
      .execute();

    const totals = new Map<number, number>();
    for (const r of rows) {
      const signed = r.is_debit === 1 ? r.base_amount : -r.base_amount;
      totals.set(r.account_id, (totals.get(r.account_id) ?? 0) + signed);
    }
    return totals;
  }

  /**
   * The same proof, asked ABOUT A PERIOD (issue #213).
   *
   * A reversal is an event with a date of its own. Whether a document belongs
   * in a period's report is therefore not "was it ever reversed" — that
   * question silently rewrites history: a document declared in February and
   * reversed in April would vanish from February's report while February's
   * ledger (and its filed KMD boxes) still contain it, and April would show
   * the removal in its boxes with no document behind it.
   *
   *  - `active`                 — nothing posted reverses it.
   *  - `released_in_period`     — an exact mirror dated INSIDE this period.
   *    Both legs are in the period's ledger and net to zero, so the report
   *    leaves both out and matches.
   *  - `released_other_period`  — an exact mirror dated OUTSIDE it. The
   *    document still belongs to the period that declared it; the removal
   *    belongs to the reversal's own period, where it is reported as its own
   *    row.
   *  - `ambiguous`              — a partial counter-voucher, or a reversal of
   *    a reversal. Nothing is dropped and nothing is netted: the affected
   *    filing is HELD (see {@link listUnsupportedAdvanceReversals}).
   */
  async classifyReversalInPeriod(
    voucherId: number,
    start: string,
    end: string,
    executor: DbExecutor = this.db,
  ): Promise<
    'active' | 'released_in_period' | 'released_other_period' | 'ambiguous'
  > {
    const state = await this.classifyReversal(voucherId, executor);
    if (state !== 'released')
      return state === 'active' ? 'active' : 'ambiguous';

    const reversals = await executor
      .selectFrom('voucher')
      .select('tax_point_date')
      .where('reverses_id', '=', voucherId)
      .where('posted_at', 'is not', null)
      .execute();

    // A mirror split across periods is not a shape this kernel posts; it is
    // held rather than half-counted.
    const inPeriod = reversals.filter(
      (r) => r.tax_point_date >= start && r.tax_point_date <= end,
    ).length;
    if (inPeriod === reversals.length) return 'released_in_period';
    if (inPeriod === 0) return 'released_other_period';
    return 'ambiguous';
  }

  /**
   * The vouchers in one advance's history whose reversal chain is not PROVED
   * either way (issue #213): the advance voucher itself, its allocations and
   * its refunds. While this is non-empty the advance's declared VAT cannot be
   * stated exactly, so every VAT-bearing path holds and says which vouchers to
   * look at.
   */
  async listUnprovenReversalChains(
    advance: PrepaymentAdvance,
    executor: DbExecutor = this.db,
  ): Promise<number[]> {
    const candidates = [advance.voucherId];

    const allocations = await executor
      .selectFrom('prepayment_allocation')
      .select('allocation_voucher_id')
      .where('advance_id', '=', advance.id)
      .execute();
    candidates.push(...allocations.map((a) => a.allocation_voucher_id));

    const refunds = await executor
      .selectFrom('prepayment_refund')
      .select('voucher_id')
      .where('advance_id', '=', advance.id)
      .execute();
    candidates.push(...refunds.map((r) => r.voucher_id));

    const unproven: number[] = [];
    for (const voucherId of candidates) {
      if ((await this.classifyReversal(voucherId, executor)) === 'ambiguous') {
        unproven.push(voucherId);
      }
    }
    return unproven;
  }

  /**
   * The advance VAT still DECLARED and not yet released (issue #213): what the
   * receipt declared, minus what allocations have relieved, minus what refunds
   * have taken back.
   *
   * An allocation or refund counts as consumed unless its reversal is PROVED
   * complete ({@link classifyReversal}). A partial or chained counter-voucher
   * therefore never hands the VAT allowance back — it holds the advance
   * instead ({@link listUnprovenReversalChains}), which is the safe direction:
   * VAT already declared stays declared until the evidence says otherwise.
   */
  async remainingAdvanceVat(
    advance: PrepaymentAdvance,
    executor: DbExecutor = this.db,
  ): Promise<number> {
    if (advance.tax.vatBaseAmount <= 0) return 0;

    const allocations = await executor
      .selectFrom('prepayment_allocation')
      .select(['allocation_voucher_id', 'vat_base_amount'])
      .where('advance_id', '=', advance.id)
      .execute();

    const refunds = await executor
      .selectFrom('prepayment_refund')
      .select(['voucher_id', 'vat_base_amount'])
      .where('advance_id', '=', advance.id)
      .execute();

    let consumed = 0;
    for (const a of allocations) {
      const state = await this.classifyReversal(
        a.allocation_voucher_id,
        executor,
      );
      if (state !== 'released') consumed += a.vat_base_amount;
    }
    for (const r of refunds) {
      const state = await this.classifyReversal(r.voucher_id, executor);
      if (state !== 'released') consumed += r.vat_base_amount;
    }

    return Math.max(0, advance.tax.vatBaseAmount - consumed);
  }

  /**
   * Base amount refunded out of one advance by refunds that still stand — the
   * same proved-reversal rule as the VAT above, so the reported net and VAT of
   * a refund are always released together or not at all.
   */
  async refundedNetForAdvance(
    advanceId: number,
    executor: DbExecutor = this.db,
  ): Promise<number> {
    const rows = await executor
      .selectFrom('prepayment_refund')
      .select(['voucher_id', 'net_base_amount'])
      .where('advance_id', '=', advanceId)
      .execute();

    let total = 0;
    for (const r of rows) {
      const state = await this.classifyReversal(r.voucher_id, executor);
      if (state !== 'released') total += r.net_base_amount;
    }
    return total;
  }

  /** The refund already recorded for one bank transaction, if any. */
  async findRefundByBankTransaction(
    bankTransactionId: number,
    executor: DbExecutor = this.db,
  ): Promise<{ id: number; advanceId: number; voucherId: number } | null> {
    const row = await executor
      .selectFrom('prepayment_refund')
      .select(['id', 'advance_id', 'voucher_id'])
      .where('bank_transaction_id', '=', bankTransactionId)
      .executeTakeFirst();
    return row
      ? { id: row.id, advanceId: row.advance_id, voucherId: row.voucher_id }
      : null;
  }

  /** Record one refund — always inside the refund's own transaction. */
  async insertRefund(values: NewRefund, executor: DbExecutor): Promise<number> {
    const inserted = await executor
      .insertInto('prepayment_refund')
      .values({
        advance_id: values.advanceId,
        voucher_id: values.voucherId,
        bank_transaction_id: values.bankTransactionId,
        net_base_amount: values.netBaseAmount,
        vat_base_amount: values.vatBaseAmount,
        currency: values.currency,
        credit_reference: values.creditReference,
        reason: values.reason,
        refund_date: values.refundDate,
        created_at: Math.floor(Date.now() / 1000),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return inserted.id;
  }

  /**
   * Customer advances RECEIVED in a period and still held as unclassified
   * (issue #213) — the receipts whose VAT a fresh return cannot honestly claim
   * to have declared or to have correctly omitted.
   *
   * Dated by the advance voucher's own tax point, which is the receipt date, so
   * this asks exactly the question the period asks. A superseded advance (its
   * voucher reversed and reposted as a classified one) is not held: the ledger
   * fact that it was undone is read the same way it is everywhere else.
   */
  async listHeldCustomerAdvances(
    start: string,
    end: string,
    executor: DbExecutor = this.db,
  ): Promise<HeldAdvanceReceipt[]> {
    const rows = await executor
      .selectFrom('prepayment_advance as pa')
      .innerJoin('voucher as v', 'v.id', 'pa.voucher_id')
      .select([
        'pa.id as advance_id',
        'pa.voucher_id as voucher_id',
        'v.voucher_number as voucher_number',
        'pa.entity_id as entity_id',
        'pa.gross_base_amount as gross_base_amount',
        'pa.original_base_amount as original_base_amount',
        'pa.currency as currency',
        'v.tax_point_date as tax_point_date',
      ])
      .where('pa.kind', '=', 'customer')
      .where('pa.tax_treatment', '=', 'unresolved')
      .where('v.posted_at', 'is not', null)
      .where('v.tax_point_date', '>=', start)
      .where('v.tax_point_date', '<=', end)
      .orderBy('v.voucher_number')
      .execute();

    const held: HeldAdvanceReceipt[] = [];
    for (const r of rows) {
      // Only a mirror dated INSIDE this period takes a receipt off the list:
      // both legs then sit in this period's ledger and cancel. A reversal in
      // a LATER period does not un-receive money this period received, and a
      // partial or chained counter-voucher proves nothing at all — both leave
      // the unclassified receipt exactly where it is, to be surfaced.
      if (
        (await this.classifyReversalInPeriod(
          r.voucher_id,
          start,
          end,
          executor,
        )) === 'released_in_period'
      )
        continue;
      held.push({
        advanceId: r.advance_id,
        voucherId: r.voucher_id,
        voucherNumber: r.voucher_number,
        entityId: r.entity_id,
        grossBaseAmount: r.gross_base_amount ?? r.original_base_amount,
        currency: r.currency,
        receiptDate: r.tax_point_date,
      });
    }
    return held;
  }

  /**
   * Taxable advance documents that belong in a period's report (issue #213) —
   * the documents a filing must be able to name, not just the VAT-control
   * totals they moved.
   *
   * Two things can put an advance in a period: the RECEIPT was dated in it,
   * or a counter-voucher dated in it took that receipt back. The second is
   * reported as its own negative row, because the reversal's legs are in THIS
   * period's ledger and the boxes already carry them — leaving it out would
   * make the documents and the boxes disagree, and dropping the original from
   * its own earlier period would rewrite a period that is very likely filed.
   */
  async listTaxableCustomerAdvances(
    start: string,
    end: string,
    executor: DbExecutor = this.db,
  ): Promise<
    {
      voucherId: number;
      voucherNumber: string;
      entityId: number | null;
      documentNumber: string | null;
      supplyDescription: string | null;
      vatCode: string | null;
      netBaseAmount: number;
      vatBaseAmount: number;
      receiptDate: string;
    }[]
  > {
    const rows = await executor
      .selectFrom('prepayment_advance as pa')
      .innerJoin('voucher as v', 'v.id', 'pa.voucher_id')
      .leftJoin('voucher as rev', (join) =>
        join
          .onRef('rev.reverses_id', '=', 'pa.voucher_id')
          .on('rev.posted_at', 'is not', null),
      )
      .select([
        'pa.voucher_id as voucher_id',
        'v.voucher_number as voucher_number',
        'pa.entity_id as entity_id',
        'pa.advance_document_number as advance_document_number',
        'pa.supply_description as supply_description',
        'pa.vat_code as vat_code',
        'pa.original_base_amount as original_base_amount',
        'pa.vat_base_amount as vat_base_amount',
        'pa.advance_tax_point_date as advance_tax_point_date',
        'v.tax_point_date as tax_point_date',
        'rev.tax_point_date as reversal_date',
      ])
      .where('pa.kind', '=', 'customer')
      .where('pa.tax_treatment', '=', 'taxable_supply')
      .where('v.posted_at', 'is not', null)
      .where((eb) =>
        eb.or([
          eb.and([
            eb('v.tax_point_date', '>=', start),
            eb('v.tax_point_date', '<=', end),
          ]),
          eb.and([
            eb('rev.tax_point_date', '>=', start),
            eb('rev.tax_point_date', '<=', end),
          ]),
        ]),
      )
      .orderBy('v.voucher_number')
      .execute();

    const documents = [];
    const seen = new Set<number>();
    for (const r of rows) {
      if (seen.has(r.voucher_id)) continue;
      seen.add(r.voucher_id);

      const receivedHere = r.tax_point_date >= start && r.tax_point_date <= end;
      // The receipt belongs to the period it was received in, full stop. A
      // counter-voucher dated in a LATER period does not delete it from this
      // one — this period's boxes still carry it — and that later period is
      // HELD instead (see listUnsupportedAdvanceReversals): there is no
      // cancellation document to report there, and reporting the advance
      // document as its own credit would invent a paper nobody issued.
      if (!receivedHere) continue;
      // Received AND mirrored here: both legs are in these boxes and cancel,
      // so the documents net out the same way.
      const state = await this.classifyReversalInPeriod(
        r.voucher_id,
        start,
        end,
        executor,
      );
      if (state === 'released_in_period') continue;

      documents.push({
        voucherId: r.voucher_id,
        voucherNumber: r.voucher_number,
        entityId: r.entity_id,
        documentNumber: r.advance_document_number,
        supplyDescription: r.supply_description,
        vatCode: r.vat_code,
        netBaseAmount: r.original_base_amount,
        vatBaseAmount: r.vat_base_amount ?? 0,
        receiptDate: r.advance_tax_point_date ?? r.tax_point_date,
      });
    }
    return documents;
  }

  /**
   * Advance documents whose reversal this period cannot report coherently
   * (issue #213). Two shapes, both HELD rather than guessed:
   *
   *  - a counter-voucher that mirrors a document only in part, one that was
   *    itself reversed, or a mirror split across two periods. Nothing can be
   *    said about how much of the advance VAT this period declares.
   *
   *  - a DRAW-DOWN or a REFUND reversed in a LATER period. Its legs put the
   *    advance VAT back into this period's boxes, and there is no document
   *    this kernel can honestly show for that: the final invoice it was
   *    netted out of belongs to an earlier period (very likely a filed one),
   *    and inventing a new advance document here would put a paper on the
   *    return that nobody issued. Reversing a RECEIPT is different and IS
   *    reported — see {@link listTaxableCustomerAdvances} — because the
   *    document it reverses is the receipt's own.
   *
   * The ledger is never touched; the filing is refused with the vouchers
   * named, so a person decides.
   */
  async listUnsupportedAdvanceReversals(
    start: string,
    end: string,
    executor: DbExecutor = this.db,
  ): Promise<string[]> {
    const rows = await executor
      .selectFrom('prepayment_advance as pa')
      .innerJoin('voucher as v', 'v.id', 'pa.voucher_id')
      .leftJoin('prepayment_allocation as pal', 'pal.advance_id', 'pa.id')
      .leftJoin('prepayment_refund as pr', 'pr.advance_id', 'pa.id')
      .select([
        'pa.voucher_id as advance_voucher_id',
        'pal.allocation_voucher_id as allocation_voucher_id',
        'pr.voucher_id as refund_voucher_id',
      ])
      .where('pa.kind', '=', 'customer')
      .where('pa.tax_treatment', '=', 'taxable_supply')
      .where('v.posted_at', 'is not', null)
      .execute();

    const candidates = new Set<number>();
    for (const r of rows) {
      candidates.add(r.advance_voucher_id);
      if (r.allocation_voucher_id !== null)
        candidates.add(r.allocation_voucher_id);
      if (r.refund_voucher_id !== null) candidates.add(r.refund_voucher_id);
    }

    const held: string[] = [];
    for (const voucherId of candidates) {
      const state = await this.classifyReversalInPeriod(
        voucherId,
        start,
        end,
        executor,
      );
      if (state === 'active') continue;

      // The WHOLE chain, not just the direct counter-voucher: a
      // reversal-of-a-reversal in a third period puts the amount back into
      // that period's boxes too, and it is just as undocumented there.
      const chain = await this.reversalChain(voucherId, executor);
      const inPeriod = (d: { tax_point_date: string }) =>
        d.tax_point_date >= start && d.tax_point_date <= end;
      const own = chain.find((d) => d.id === voucherId);
      const documentHere = own !== undefined && inPeriod(own);

      if (state === 'ambiguous') {
        // Held wherever any leg of the chain touches the period: nothing
        // about how much it declares can be stated where it appears.
        if (!chain.some(inPeriod)) continue;
      } else {
        // A proved mirror. The document's own period reports the document;
        // the period the REMOVAL lands in has no document to report it as,
        // so that period is the one that is held.
        const removalHere = chain.some(
          (d) => d.id !== voucherId && inPeriod(d),
        );
        if (documentHere || !removalHere) continue;
      }

      if (own) held.push(own.voucher_number);
    }
    return [...new Set(held)].sort();
  }

  /**
   * Advance VAT RELIEVED in a period (issue #213): one row per draw-down of a
   * taxable advance, dated at the tax point it was posted with — the final
   * invoice's own. These are the documents that keep KMD and INF coherent: the
   * invoice reports the supply in full, and the advance already reported is
   * taken back against the document that reported it.
   */
  async listAdvanceReliefs(
    start: string,
    end: string,
    executor: DbExecutor = this.db,
  ): Promise<
    {
      entityId: number | null;
      advanceDocumentNumber: string | null;
      advanceVoucherNumber: string;
      invoiceVoucherId: number;
      invoiceNumber: string | null;
      date: string;
      vatCode: string | null;
      netBaseAmount: number;
      vatBaseAmount: number;
    }[]
  > {
    const rows = await executor
      .selectFrom('prepayment_allocation as pal')
      .innerJoin('prepayment_advance as pa', 'pa.id', 'pal.advance_id')
      .innerJoin('voucher as av', 'av.id', 'pa.voucher_id')
      .innerJoin('voucher as v', 'v.id', 'pal.allocation_voucher_id')
      .leftJoin(
        'sales_invoice as si',
        'si.voucher_id',
        'pal.invoice_voucher_id',
      )
      .select([
        'pal.allocation_voucher_id as allocation_voucher_id',
        'pal.invoice_voucher_id as invoice_voucher_id',
        'pa.entity_id as entity_id',
        'pa.advance_document_number as advance_document_number',
        'av.voucher_number as advance_voucher_number',
        'pa.vat_code as vat_code',
        'si.invoice_number as invoice_number',
        'pal.base_amount as base_amount',
        'pal.vat_base_amount as vat_base_amount',
        'v.tax_point_date as tax_point_date',
      ])
      .where('pa.tax_treatment', '=', 'taxable_supply')
      .where('pal.vat_base_amount', '>', 0)
      .where('v.posted_at', 'is not', null)
      .where('v.tax_point_date', '>=', start)
      .where('v.tax_point_date', '<=', end)
      .orderBy('v.id')
      .execute();

    const reliefs = [];
    for (const r of rows) {
      // A relief mirrored INSIDE this period relieved nothing here: both legs
      // are in these boxes and cancel. One mirrored in a LATER period still
      // relieved this one, and its removal is reported in the period the
      // counter-voucher is dated in — never back here (issue #213).
      if (
        (await this.classifyReversalInPeriod(
          r.allocation_voucher_id,
          start,
          end,
          executor,
        )) === 'released_in_period'
      ) {
        continue;
      }
      reliefs.push({
        entityId: r.entity_id,
        advanceDocumentNumber: r.advance_document_number,
        advanceVoucherNumber: r.advance_voucher_number,
        invoiceVoucherId: r.invoice_voucher_id,
        invoiceNumber: r.invoice_number,
        date: r.tax_point_date,
        vatCode: r.vat_code,
        netBaseAmount: r.base_amount,
        vatBaseAmount: r.vat_base_amount,
      });
    }
    return reliefs;
  }

  /**
   * Advance VAT taken back by a REFUND in a period (issue #213), under the
   * cancellation/credit document the relief was recorded with.
   */
  async listAdvanceRefunds(
    start: string,
    end: string,
    executor: DbExecutor = this.db,
  ): Promise<
    {
      entityId: number | null;
      advanceDocumentNumber: string | null;
      advanceVoucherNumber: string;
      creditReference: string;
      date: string;
      vatCode: string | null;
      netBaseAmount: number;
      vatBaseAmount: number;
    }[]
  > {
    const rows = await executor
      .selectFrom('prepayment_refund as pr')
      .innerJoin('prepayment_advance as pa', 'pa.id', 'pr.advance_id')
      .innerJoin('voucher as av', 'av.id', 'pa.voucher_id')
      .innerJoin('voucher as v', 'v.id', 'pr.voucher_id')
      .select([
        'pr.voucher_id as voucher_id',
        'pa.entity_id as entity_id',
        'pa.advance_document_number as advance_document_number',
        'av.voucher_number as advance_voucher_number',
        'pa.vat_code as vat_code',
        'pr.credit_reference as credit_reference',
        'pr.net_base_amount as net_base_amount',
        'pr.vat_base_amount as vat_base_amount',
        'pr.refund_date as refund_date',
      ])
      .where('pa.tax_treatment', '=', 'taxable_supply')
      .where('pr.vat_base_amount', '>', 0)
      .where('v.posted_at', 'is not', null)
      .where('pr.refund_date', '>=', start)
      .where('pr.refund_date', '<=', end)
      .orderBy('v.id')
      .execute();

    const refunds = [];
    for (const r of rows) {
      if (
        (await this.classifyReversalInPeriod(
          r.voucher_id,
          start,
          end,
          executor,
        )) === 'released_in_period'
      )
        continue;
      refunds.push({
        entityId: r.entity_id,
        advanceDocumentNumber: r.advance_document_number,
        advanceVoucherNumber: r.advance_voucher_number,
        creditReference: r.credit_reference,
        date: r.refund_date,
        vatCode: r.vat_code,
        netBaseAmount: r.net_base_amount,
        vatBaseAmount: r.vat_base_amount,
      });
    }
    return refunds;
  }

  /**
   * One voucher and every posted counter-voucher descending from it — the
   * reversal, the reversal of that reversal, and so on. Each link puts the
   * amount back into the boxes of whatever period it is dated in, so the
   * whole chain decides which periods a reversal concerns.
   */
  private async reversalChain(
    voucherId: number,
    executor: DbExecutor,
  ): Promise<{ id: number; voucher_number: string; tax_point_date: string }[]> {
    const chain: {
      id: number;
      voucher_number: string;
      tax_point_date: string;
    }[] = [];
    const seen = new Set<number>();
    let frontier = [voucherId];

    while (frontier.length > 0) {
      const rows = await executor
        .selectFrom('voucher')
        .select(['id', 'voucher_number', 'tax_point_date'])
        .where((eb) =>
          eb.or([eb('id', 'in', frontier), eb('reverses_id', 'in', frontier)]),
        )
        .where('posted_at', 'is not', null)
        .execute();

      const next: number[] = [];
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        chain.push(r);
        next.push(r.id);
      }
      frontier = next;
    }
    return chain;
  }

  /**
   * Record the advance INVOICE NUMBER on an advance that has none (issue
   * #213). A document number is a record of something that was issued, not a
   * tax decision, so it is the one advance fact that can be filled in after
   * the classification — and only from empty, conditionally, so a number
   * already on a filed return is never quietly replaced.
   */
  async claimAdvanceDocumentNumber(
    advanceId: number,
    documentNumber: string,
    executor: DbExecutor = this.db,
  ): Promise<boolean> {
    const updated = await executor
      .updateTable('prepayment_advance')
      .set({ advance_document_number: documentNumber })
      .where('id', '=', advanceId)
      .where('advance_document_number', 'is', null)
      .executeTakeFirst();
    return Number(updated.numUpdatedRows) === 1;
  }

  /**
   * CLAIM an unclassified advance as a non-taxable deposit (issue #213).
   *
   * Conditional on the row still being unresolved and not superseded, and it
   * writes only the fields the classification states — never a whole object
   * read before the transaction, which would put back a stale
   * `superseded_by_advance_id` and undo a concurrent reclassification.
   *
   * Returns false when the claim was lost: another classification got there
   * first, and the caller must abort without writing anything.
   */
  async claimAsDeposit(
    advanceId: number,
    facts: { supplyDescription: string | null; documentNumber: string | null },
    executor: DbExecutor,
  ): Promise<boolean> {
    const updated = await executor
      .updateTable('prepayment_advance')
      .set({
        tax_treatment: 'non_taxable_deposit',
        supply_description: facts.supplyDescription,
        advance_document_number: facts.documentNumber,
      })
      .where('id', '=', advanceId)
      .where('tax_treatment', '=', 'unresolved')
      .where('superseded_by_advance_id', 'is', null)
      .executeTakeFirst();
    return Number(updated.numUpdatedRows) === 1;
  }

  /**
   * CLAIM an unclassified advance as superseded by the VAT-bearing advance
   * that replaces it (issue #213), on the same conditions and in the same
   * transaction as the postings that create the replacement.
   *
   * Returns false when the claim was lost, so the caller's transaction — the
   * reversal and the repost included — rolls back whole and the winner's
   * history is the only one.
   */
  async claimSupersededBy(
    advanceId: number,
    replacementAdvanceId: number,
    executor: DbExecutor,
  ): Promise<boolean> {
    const updated = await executor
      .updateTable('prepayment_advance')
      .set({ superseded_by_advance_id: replacementAdvanceId })
      .where('id', '=', advanceId)
      .where('tax_treatment', '=', 'unresolved')
      .where('superseded_by_advance_id', 'is', null)
      .executeTakeFirst();
    return Number(updated.numUpdatedRows) === 1;
  }

  /** Assign the owner of a previously unresolved advance. */
  async setAdvanceEntity(
    advanceId: number,
    entityId: number,
    executor: DbExecutor = this.db,
  ): Promise<void> {
    await executor
      .updateTable('prepayment_advance')
      .set({ entity_id: entityId })
      .where('id', '=', advanceId)
      .execute();
  }

  /**
   * Lift the unverified-balance flag from every advance of one kind. The caller
   * must first establish that no unlinked draw-down of that kind is left — the
   * flag is about the KIND's unattributed history, not about one row.
   */
  async clearNeedsReviewForKind(
    kind: 'customer' | 'supplier',
    executor: DbExecutor = this.db,
  ): Promise<void> {
    await executor
      .updateTable('prepayment_advance')
      .set({ needs_review: 0 })
      .where('kind', '=', kind)
      .execute();
  }
}

/**
 * The active-allocation predicate: no POSTED voucher reverses this allocation's
 * voucher. One reversal releases one allocation.
 */
function notReversed(eb: ExpressionBuilder<Database, 'prepayment_allocation'>) {
  return eb.not(
    eb.exists(
      eb
        .selectFrom('voucher as rev')
        .select('rev.id')
        .whereRef(
          'rev.reverses_id',
          '=',
          'prepayment_allocation.allocation_voucher_id',
        )
        .where('rev.posted_at', 'is not', null),
    ),
  );
}

function toAdvance(row: {
  id: number;
  voucher_id: number;
  kind: string;
  account_code: string;
  entity_id: number | null;
  bank_transaction_id: number | null;
  original_base_amount: number;
  currency: string;
  needs_review: number;
  origin: string;
  tax_treatment: string;
  vat_code: string | null;
  vat_rate_permille: number | null;
  gross_base_amount: number | null;
  vat_base_amount: number;
  supply_description: string | null;
  advance_document_number: string | null;
  advance_tax_point_date: string | null;
  superseded_by_advance_id: number | null;
}): PrepaymentAdvance {
  return {
    id: row.id,
    voucherId: row.voucher_id,
    kind: row.kind === 'supplier' ? 'supplier' : 'customer',
    accountCode: row.account_code,
    entityId: row.entity_id,
    bankTransactionId: row.bank_transaction_id,
    originalBaseAmount: row.original_base_amount,
    currency: row.currency,
    needsReview: row.needs_review === 1,
    origin: row.origin,
    tax: {
      treatment: toTreatment(row.tax_treatment),
      vatCode: row.vat_code,
      vatRatePermille: row.vat_rate_permille,
      // A pre-#213 row carries no gross of its own: its gross IS the
      // prepayment leg, because no VAT was ever split out of it.
      grossBaseAmount: row.gross_base_amount ?? row.original_base_amount,
      vatBaseAmount: row.vat_base_amount ?? 0,
      supplyDescription: row.supply_description,
      advanceDocumentNumber: row.advance_document_number,
      advanceTaxPointDate: row.advance_tax_point_date,
      supersededByAdvanceId: row.superseded_by_advance_id,
    },
  };
}

/**
 * The stored treatment, read strictly: anything this code does not recognise is
 * HELD as unresolved rather than treated as a classified deposit.
 */
function toTreatment(value: string): AdvanceTaxTreatment {
  if (value === 'taxable_supply' || value === 'non_taxable_deposit') {
    return value;
  }
  return 'unresolved';
}
