import { Kysely } from 'kysely';
import { Database } from '../types';

/**
 * Issue #201: give a prepayment an OWNER and every draw-down an explicit LINK.
 *
 * Before this migration a prepayment's remaining balance was re-derived by
 * summing every draw-down-shaped voucher in the ledger, so drawing down advance
 * A silently reduced the reported balance of unrelated advance B, and candidate
 * lookup stamped the caller's entity onto every prepayment voucher it returned.
 * The ledger itself was right; what was missing was the reconciliation-side
 * record of WHICH advance was drawn against WHICH invoice, and for WHOM.
 *
 * Two tables, both reconciliation records (not ledger evidence — the Voucher
 * stays the system of record; these rows only say what the vouchers MEAN):
 *
 *  - `prepayment_advance` — one row per posted advance voucher: its kind
 *    (customer/supplier), its counterparty, and the bank transaction it came
 *    from (source provenance). `entity_id` is nullable because an advance whose
 *    counterparty could not be resolved deterministically must be VISIBLE and
 *    UNALLOCATABLE rather than silently attributed to whoever asks.
 *
 *  - `prepayment_allocation` — one row per draw-down: source advance, target
 *    invoice voucher, counterparty, base amount, and the posted allocation
 *    voucher. An allocation is RELEASED (stops consuming the advance) exactly
 *    when its allocation voucher has been reversed — derived from the ledger
 *    (`voucher.reverses_id`), never from a second, drift-prone status column.
 *    An advance whose OWN voucher was reversed is cancelled by the same rule.
 *
 * ── Backfill of pre-existing data ───────────────────────────────────────
 * Classification is per VOUCHER, not per line: a voucher's prepayment legs are
 * netted by account first, so a legal multi-leg advance yields exactly one
 * advance row (`voucher_id` is UNIQUE) and a voucher whose prepayment legs net
 * to zero is no advance at all.
 *
 * Reversals are classified EXPLICITLY, never as an unknown shape: a voucher
 * carrying `reverses_id` is a counter-voucher, so it is neither an advance nor
 * an allocation. Its effect is already derived — reversing a draw-down releases
 * exactly that allocation, and reversing an advance cancels exactly that
 * advance (it never becomes available again).
 *
 * Every pre-existing advance voucher gets a row with `entity_id = NULL`
 * (`origin = 'backfill'`): the counterparty is genuinely unknown, so allocation
 * is blocked until an operator resolves it. Pre-existing draw-downs are
 * re-linked ONLY from the machine-written `reason` marker
 * `Draw-down of prepayment V-<id> against invoice V-<id>` AND only when the
 * whole shape validates against the ledger: the clearing voucher is posted and
 * is EXACTLY the two-legged pair for its kind (prepayment leg against the
 * relieved AR/AP leg, equal base amounts, opposite polarities), the named
 * advance has the matching kind, the named target is a posted voucher carrying
 * that AR/AP leg in its opening direction, and the amount fits what is left of
 * the advance — counting only draw-downs that were NOT themselves reversed, so
 * re-drawing credit freed by a reversal is not mistaken for an overdraw. A
 * draw-down that fails any of those checks is NOT guessed at: every backfilled advance of that kind is
 * flagged `needs_review = 1`, which reports its remaining balance as UNKNOWN
 * and blocks allocation, because the unlinked draw-down could belong to any of
 * them. Nothing here marks a used historical advance fully available, and no
 * posted voucher is edited.
 *
 * Clearing that flag is not a number an operator types: the repair path
 * (`POST /api/prepayments/:voucherId/ownership`) takes EXPLICIT links from the
 * still-unlinked draw-down vouchers to their source advance and target invoice,
 * validates each against the ledger, and only lifts the flag for a kind once no
 * unlinked draw-down of that kind is left.
 */

/** Machine-written draw-down marker; the ONLY string this backfill trusts. */
const DRAW_DOWN_REASON =
  /^Draw-down of prepayment V-(\d+) against invoice V-(\d+)$/;

const CUSTOMER_PREPAYMENTS = 'CUSTOMER_PREPAYMENTS';
const SUPPLIER_PREPAYMENTS = 'SUPPLIER_PREPAYMENTS';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('prepayment_advance')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    // The posted advance voucher. One advance per voucher.
    .addColumn('voucher_id', 'integer', (col) =>
      col.notNull().unique().references('voucher.id'),
    )
    // 'customer' (a liability we owe) | 'supplier' (an asset we prepaid).
    .addColumn('kind', 'text', (col) => col.notNull())
    .addColumn('account_code', 'text', (col) => col.notNull())
    // The counterparty this advance belongs to. NULL = unresolved: visible,
    // but not allocatable until an operator resolves it.
    .addColumn('entity_id', 'integer', (col) => col.references('entity.id'))
    // Source bank provenance — the transaction the money arrived on.
    .addColumn('bank_transaction_id', 'integer', (col) =>
      col.references('bank_transaction.id'),
    )
    // Base-currency minor units of the advance's netted prepayment leg.
    .addColumn('original_base_amount', 'integer', (col) => col.notNull())
    .addColumn('currency', 'text', (col) => col.notNull())
    // 1 = remaining balance is UNKNOWN (an unlinked historical draw-down of
    // this kind exists) → reported as unknown and blocked from allocation.
    .addColumn('needs_review', 'integer', (col) => col.notNull().defaultTo(0))
    // 'service' | 'backfill' | 'operator'
    .addColumn('origin', 'text', (col) => col.notNull())
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('idx_prepayment_advance_entity')
    .ifNotExists()
    .on('prepayment_advance')
    .columns(['entity_id', 'kind'])
    .execute();

  await db.schema
    .createTable('prepayment_allocation')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('advance_id', 'integer', (col) =>
      col.notNull().references('prepayment_advance.id'),
    )
    .addColumn('invoice_voucher_id', 'integer', (col) =>
      col.notNull().references('voucher.id'),
    )
    // The counterparty both sides shared when the allocation was made. NULL
    // only for backfilled rows, whose advance is unresolved anyway.
    .addColumn('entity_id', 'integer', (col) => col.references('entity.id'))
    .addColumn('base_amount', 'integer', (col) => col.notNull())
    .addColumn('currency', 'text', (col) => col.notNull())
    // The posted clearing voucher. Its reversal releases THIS allocation and
    // no other — one allocation voucher, one allocation.
    .addColumn('allocation_voucher_id', 'integer', (col) =>
      col.notNull().unique().references('voucher.id'),
    )
    // 'service' | 'backfill' | 'operator'
    .addColumn('origin', 'text', (col) => col.notNull())
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('idx_prepayment_allocation_advance')
    .ifNotExists()
    .on('prepayment_allocation')
    .columns(['advance_id'])
    .execute();

  await db.schema
    .createIndex('idx_prepayment_allocation_invoice')
    .ifNotExists()
    .on('prepayment_allocation')
    .columns(['invoice_voucher_id'])
    .execute();

  await backfill(db);
}

/** One pre-existing voucher, classified by its NETTED prepayment legs. */
interface PrepaymentVoucher {
  voucherId: number;
  kind: 'customer' | 'supplier';
  accountCode: string;
  /** Signed net of the kind's prepayment legs: + = debit, − = credit. */
  netBase: number;
  currency: string;
  reason: string | null;
  isReversal: boolean;
  hasArAp: boolean;
}

async function backfill(db: Kysely<Database>): Promise<void> {
  const vouchers = await classifyVouchers(db);
  if (vouchers.length === 0) return;

  // Vouchers a POSTED counter-voucher reverses. A reversed draw-down consumed
  // nothing in the end; a reversed advance is cancelled, not re-available.
  const reversedVoucherIds = await loadReversedVoucherIds(db);

  const now = Math.floor(Date.now() / 1000);

  /** advance voucher_id → its row, for the draw-down pass. */
  const advanceByVoucher = new Map<
    number,
    { id: number; kind: string; remaining: number }
  >();
  const drawDowns: PrepaymentVoucher[] = [];
  const unlinkedKinds = new Set<string>();

  for (const v of vouchers) {
    // A counter-voucher is neither an advance nor an allocation: reversing a
    // draw-down releases that allocation, and reversing an advance cancels that
    // advance. Both are derived from `reverses_id` at read time.
    if (v.isReversal) continue;

    // Advance creation: the prepayment account moves in its OPENING direction
    // (customer credit / supplier debit) with no AR/AP leg on the voucher.
    const opensCustomer = v.kind === 'customer' && v.netBase < 0;
    const opensSupplier = v.kind === 'supplier' && v.netBase > 0;
    if ((opensCustomer || opensSupplier) && !v.hasArAp) {
      // `voucher_id` is UNIQUE: one voucher cannot open two advances. A voucher
      // opening both a customer and a supplier advance is not a shape this
      // kernel posts — record neither and flag both kinds rather than abort.
      if (advanceByVoucher.has(v.voucherId)) {
        unlinkedKinds.add(v.kind);
        unlinkedKinds.add(advanceByVoucher.get(v.voucherId)!.kind);
        continue;
      }
      const inserted = await db
        .insertInto('prepayment_advance')
        .values({
          voucher_id: v.voucherId,
          kind: v.kind,
          account_code: v.accountCode,
          entity_id: null,
          bank_transaction_id: null,
          original_base_amount: Math.abs(v.netBase),
          currency: v.currency,
          needs_review: 0,
          origin: 'backfill',
          created_at: now,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      advanceByVoucher.set(v.voucherId, {
        id: inserted.id,
        kind: v.kind,
        remaining: Math.abs(v.netBase),
      });
      continue;
    }

    // Draw-down: the prepayment account moves the OTHER way, against AR/AP.
    const drawsCustomer = v.kind === 'customer' && v.netBase > 0;
    const drawsSupplier = v.kind === 'supplier' && v.netBase < 0;
    if ((drawsCustomer || drawsSupplier) && v.hasArAp) {
      drawDowns.push(v);
      continue;
    }

    // Prepayment legs that net to zero are not an advance and consume nothing.
    if (v.netBase === 0) continue;

    // Any other shape: this kind's balances can no longer be derived.
    unlinkedKinds.add(v.kind);
  }

  // Chronological, so the per-advance limit below is applied in the order the
  // draw-downs actually happened.
  drawDowns.sort((a, b) => a.voucherId - b.voucherId);

  for (const v of drawDowns) {
    const link = resolveMarker(v, advanceByVoucher);
    if (link === null) {
      unlinkedKinds.add(v.kind);
      continue;
    }
    const amount = Math.abs(v.netBase);
    const shapeOk = await isTrustedClearingVoucher(db, {
      kind: v.kind,
      allocationVoucherId: v.voucherId,
      invoiceVoucherId: link.invoiceVoucherId,
      amount,
    });
    if (!shapeOk) {
      unlinkedKinds.add(v.kind);
      continue;
    }

    // A RELEASED draw-down (its own voucher was reversed) is recorded for the
    // history it is, but consumes nothing — so a re-draw of the same credit
    // after a reversal is not mistaken for an overdraw.
    const released = reversedVoucherIds.has(v.voucherId);
    if (!released && amount > link.advance.remaining) {
      unlinkedKinds.add(v.kind);
      continue;
    }
    if (!released) link.advance.remaining -= amount;

    await db
      .insertInto('prepayment_allocation')
      .values({
        advance_id: link.advance.id,
        invoice_voucher_id: link.invoiceVoucherId,
        entity_id: null,
        base_amount: amount,
        currency: v.currency,
        allocation_voucher_id: v.voucherId,
        origin: 'backfill',
        created_at: now,
      })
      .execute();
  }

  for (const kind of unlinkedKinds) {
    await db
      .updateTable('prepayment_advance')
      .set({ needs_review: 1 })
      .where('origin', '=', 'backfill')
      .where('kind', '=', kind)
      .execute();
  }
}

/**
 * Net every voucher's prepayment legs BY ACCOUNT, so classification is one
 * decision per voucher per kind rather than one per line.
 */
async function classifyVouchers(
  db: Kysely<Database>,
): Promise<PrepaymentVoucher[]> {
  const legs = await db
    .selectFrom('voucher_line')
    .innerJoin('account', 'account.id', 'voucher_line.account_id')
    .innerJoin('voucher', 'voucher.id', 'voucher_line.voucher_id')
    .select([
      'voucher_line.voucher_id as voucher_id',
      'account.code as account_code',
      'voucher_line.is_debit as is_debit',
      'voucher_line.base_amount as base_amount',
      'voucher_line.currency as currency',
      'voucher.reason as reason',
      'voucher.reverses_id as reverses_id',
    ])
    .where('account.code', 'in', [CUSTOMER_PREPAYMENTS, SUPPLIER_PREPAYMENTS])
    .orderBy('voucher_line.id')
    .execute();

  const arApVoucherIds = new Set(
    (
      await db
        .selectFrom('voucher_line')
        .innerJoin('account', 'account.id', 'voucher_line.account_id')
        .select('voucher_line.voucher_id as voucher_id')
        .where('account.code', 'in', ['AR', 'AP'])
        .execute()
    ).map((r) => r.voucher_id),
  );

  const byVoucherAndCode = new Map<string, PrepaymentVoucher>();
  for (const leg of legs) {
    const kind =
      leg.account_code === CUSTOMER_PREPAYMENTS ? 'customer' : 'supplier';
    const key = `${leg.voucher_id}:${leg.account_code}`;
    const signed = leg.is_debit === 1 ? leg.base_amount : -leg.base_amount;
    const existing = byVoucherAndCode.get(key);
    if (existing) {
      existing.netBase += signed;
      continue;
    }
    byVoucherAndCode.set(key, {
      voucherId: leg.voucher_id,
      kind,
      accountCode: leg.account_code,
      netBase: signed,
      currency: leg.currency,
      reason: leg.reason,
      isReversal: leg.reverses_id !== null,
      hasArAp: arApVoucherIds.has(leg.voucher_id),
    });
  }

  return [...byVoucherAndCode.values()];
}

/**
 * Read the machine-written marker off a historical draw-down and find the
 * advance it names. An unverifiable marker is treated as no marker at all.
 */
function resolveMarker(
  v: PrepaymentVoucher,
  advanceByVoucher: Map<
    number,
    { id: number; kind: string; remaining: number }
  >,
): {
  advance: { id: number; kind: string; remaining: number };
  invoiceVoucherId: number;
} | null {
  const match = v.reason === null ? null : DRAW_DOWN_REASON.exec(v.reason);
  if (!match) return null;

  const advance = advanceByVoucher.get(Number(match[1]));
  if (!advance || advance.kind !== v.kind) return null;

  return { advance, invoiceVoucherId: Number(match[2]) };
}

/**
 * Is this voucher one we can TRUST as the clearing voucher its marker claims?
 *
 * The marker is machine-written, but a hand-posted voucher could carry the same
 * `reason`, so the backfill believes it only when the ledger agrees on the
 * whole shape: the voucher is posted, is EXACTLY the two-legged clearing pair
 * for this kind (prepayment leg against the relieved AR/AP leg, same base
 * amount, opposite polarities), and the named target is a posted voucher
 * carrying that AR/AP leg in its OPENING direction. Anything else — an extra
 * leg, a mismatched amount, a wrong side — is left unlinked and surfaces as an
 * unresolved balance rather than silently relieving somebody's invoice.
 */
async function isTrustedClearingVoucher(
  db: Kysely<Database>,
  params: {
    kind: 'customer' | 'supplier';
    allocationVoucherId: number;
    invoiceVoucherId: number;
    amount: number;
  },
): Promise<boolean> {
  const { kind, allocationVoucherId, invoiceVoucherId, amount } = params;
  if (amount <= 0) return false;

  const prepaymentCode =
    kind === 'customer' ? CUSTOMER_PREPAYMENTS : SUPPLIER_PREPAYMENTS;
  const relievedCode = kind === 'customer' ? 'AR' : 'AP';
  // Customer: Dr CUSTOMER_PREPAYMENTS / Cr AR. Supplier: Dr AP / Cr SUPPLIER_PREPAYMENTS.
  const prepaymentIsDebit = kind === 'customer' ? 1 : 0;

  const clearing = await loadPostedLines(db, allocationVoucherId);
  if (clearing === null || clearing.length !== 2) return false;

  const prepaymentLeg = clearing.find((l) => l.code === prepaymentCode);
  const relievedLeg = clearing.find((l) => l.code === relievedCode);
  if (!prepaymentLeg || !relievedLeg) return false;
  if (prepaymentLeg.is_debit !== prepaymentIsDebit) return false;
  if (relievedLeg.is_debit === prepaymentIsDebit) return false;
  if (prepaymentLeg.base_amount !== amount) return false;
  if (relievedLeg.base_amount !== amount) return false;

  // The named target must be a posted voucher carrying the AR/AP leg this kind
  // draws against, in its OPENING direction — the OPPOSITE of the clearing
  // voucher's relieving leg (AR debit against an AR credit; AP credit against
  // an AP debit).
  const target = await loadPostedLines(db, invoiceVoucherId);
  if (target === null) return false;
  return target.some(
    (l) => l.code === relievedCode && l.is_debit === prepaymentIsDebit,
  );
}

/** Every line of a POSTED voucher, or null if the voucher is not posted. */
async function loadPostedLines(
  db: Kysely<Database>,
  voucherId: number,
): Promise<{ code: string; is_debit: number; base_amount: number }[] | null> {
  const voucher = await db
    .selectFrom('voucher')
    .select('id')
    .where('id', '=', voucherId)
    .where('posted_at', 'is not', null)
    .executeTakeFirst();
  if (!voucher) return null;

  return db
    .selectFrom('voucher_line')
    .innerJoin('account', 'account.id', 'voucher_line.account_id')
    .select([
      'account.code as code',
      'voucher_line.is_debit as is_debit',
      'voucher_line.base_amount as base_amount',
    ])
    .where('voucher_line.voucher_id', '=', voucherId)
    .execute();
}

/** Ids of vouchers a POSTED counter-voucher reverses. */
async function loadReversedVoucherIds(
  db: Kysely<Database>,
): Promise<Set<number>> {
  const rows = await db
    .selectFrom('voucher')
    .select('reverses_id')
    .where('reverses_id', 'is not', null)
    .where('posted_at', 'is not', null)
    .execute();
  return new Set(
    rows.map((r) => r.reverses_id).filter((id): id is number => id !== null),
  );
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('prepayment_allocation').ifExists().execute();
  await db.schema.dropTable('prepayment_advance').ifExists().execute();
}
