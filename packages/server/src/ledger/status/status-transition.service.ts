import { Injectable, ConflictException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../../database/types';
import { BusinessObjectStatus } from '../../common/types/business-object-status';

/**
 * The business-object tables whose `status` column this seam owns. The
 * object_type is a closed discriminator (`expense | sales_invoice`) so the
 * dynamic-table dispatch stays type-safe at the module boundary — no `any`.
 */
export type TransitionableObjectType = 'expense' | 'sales_invoice';

/** Human label per type, for clear conflict messages. */
const LABEL: Record<TransitionableObjectType, string> = {
  expense: 'Expense',
  sales_invoice: 'SalesInvoice',
};

/**
 * The legal status transition graph for the expense / sales_invoice status
 * machine (ADR-0006). A transition is legal iff its target appears in the
 * source state's allow-set. Anything else (e.g. posted→draft, reversed→posted,
 * re-posting a reversed object) is an ILLEGAL transition and is rejected before
 * any UPDATE is issued.
 *
 *   draft   → pending | posted   (hold-for-approval; auto-post)
 *   pending → posted  | draft    (approve; reject back to draft)
 *   posted  → reversed           (correction reverses the voucher, ADR-0006)
 *   reversed→ (terminal)         (no outgoing transitions)
 */
const TRANSITION_GRAPH: Record<
  BusinessObjectStatus,
  ReadonlySet<BusinessObjectStatus>
> = {
  draft: new Set<BusinessObjectStatus>(['pending', 'posted']),
  pending: new Set<BusinessObjectStatus>(['posted', 'draft']),
  posted: new Set<BusinessObjectStatus>(['reversed']),
  reversed: new Set<BusinessObjectStatus>(),
};

/**
 * Thrown when a transition (from → to) is not in {@link TRANSITION_GRAPH}.
 * This is the ONE behavior this module adds over the old blind UPDATE: an
 * illegal transition is rejected up front rather than silently issuing an
 * UPDATE that the DB CHECK (which only constrains the value SET, not the graph)
 * would have accepted.
 */
export class IllegalStatusTransitionError extends Error {
  constructor(
    readonly type: TransitionableObjectType,
    readonly id: number,
    readonly from: BusinessObjectStatus,
    readonly to: BusinessObjectStatus,
  ) {
    super(
      `Illegal status transition for ${LABEL[type]} ${id}: ${from} → ${to}`,
    );
    this.name = 'IllegalStatusTransitionError';
  }
}

/**
 * Extra columns to set atomically alongside the status flip — e.g. re-pointing
 * a corrected object at its new Voucher (`posted → reversed` + `voucher_id`).
 * Constrained to the columns this seam is allowed to co-write so the dynamic
 * dispatch stays type-safe at the boundary (no `any`).
 */
export interface TransitionExtras {
  voucher_id?: number;
}

export interface TransitionOptions {
  /** Override the ConflictException message when the row isn't claimed. */
  conflictMessage?: (actual: string) => string;
  /** Columns to set atomically with the status flip (e.g. voucher_id). */
  extras?: TransitionExtras;
}

/**
 * StatusTransitionService — the SINGLE seam that owns business-object status
 * transitions for the expense / sales_invoice status machine (ADR-0006).
 *
 * It is the one place that knows the legal transition graph AND performs the
 * transition. Every write of these objects' `status` flows through here:
 *  - the posting pipeline (auto-post `draft → posted`, hold `draft → pending`),
 *  - approvals (`pending → posted` on approve, `pending → draft` on reject),
 *  - corrections (`posted → reversed`, re-pointed at the corrected voucher).
 *
 * Two guarantees, in order:
 *  1. LEGALITY — {@link transition} rejects any (from → to) not in the graph
 *     ({@link IllegalStatusTransitionError}) BEFORE touching the row. The DB
 *     CHECK only constrains the value set, not the graph, so this is the only
 *     place posted→draft / reversed→posted are caught.
 *  2. ATOMIC IDEMPOTENCY (ADR-0021) — the flip is a single conditional
 *     `UPDATE … SET status = <to> WHERE id = ? AND status = <from> RETURNING id`.
 *     Zero rows claimed → the object was already claimed/posted → 409
 *     ConflictException, no second voucher. This is exactly the old
 *     PostingService.claimObjectStatus primitive, folded in unchanged.
 */
@Injectable()
export class StatusTransitionService {
  /** True iff `from → to` is a legal transition in the status machine. */
  isLegal(from: BusinessObjectStatus, to: BusinessObjectStatus): boolean {
    return TRANSITION_GRAPH[from].has(to);
  }

  /**
   * Guarded atomic status transition inside an existing transaction (trx).
   *
   * Rejects an illegal `from → to` ({@link IllegalStatusTransitionError}), then
   * issues the conditional UPDATE that atomically claims the object only from
   * `from`. Zero rows claimed → ConflictException (ADR-0021 idempotency).
   */
  async transition(
    trx: Kysely<Database>,
    type: TransitionableObjectType,
    id: number,
    from: BusinessObjectStatus,
    to: BusinessObjectStatus,
    options: TransitionOptions = {},
  ): Promise<void> {
    if (!this.isLegal(from, to)) {
      throw new IllegalStatusTransitionError(type, id, from, to);
    }

    const now = Math.floor(Date.now() / 1000);
    const claimed = await trx
      .updateTable(type)
      .set({
        status: to,
        updated_at: now,
        ...(options.extras?.voucher_id !== undefined && {
          voucher_id: options.extras.voucher_id,
        }),
      })
      .where('id', '=', id)
      .where('status', '=', from)
      .returning('id')
      .executeTakeFirst();

    if (!claimed) {
      const current = await trx
        .selectFrom(type)
        .select('status')
        .where('id', '=', id)
        .executeTakeFirst();
      const actual = current?.status ?? 'unknown';
      throw new ConflictException(
        options.conflictMessage
          ? options.conflictMessage(actual)
          : `${LABEL[type]} ${id} is already ${actual}`,
      );
    }
  }
}
