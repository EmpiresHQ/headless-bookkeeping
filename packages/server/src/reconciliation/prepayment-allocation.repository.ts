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
   * Base amount already allocated AGAINST one invoice voucher by still-active
   * allocations — the term that keeps a later draw-down, or a later cash match,
   * from settling a receivable a prepayment has already relieved.
   */
  async activeAllocatedForInvoice(
    invoiceVoucherId: number,
    executor: DbExecutor = this.db,
  ): Promise<number> {
    const row = await executor
      .selectFrom('prepayment_allocation')
      .select((eb) => eb.fn.sum<number>('base_amount').as('total'))
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
    return row?.total ?? 0;
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
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return inserted.id;
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
  };
}
