import { Kysely, sql } from 'kysely';
import { Database } from '../types';

/**
 * Migration 075 (issue #208): per-asset attribution of posted depreciation.
 *
 * The annual close posts ONE voucher whose ACCUM_DEPRECIATION_* lines are
 * aggregated per asset CLASS. Nothing in the ledger therefore says how much of
 * a class's posted depreciation belongs to a single asset — so a disposal could
 * not tell what had already been charged for the asset it was retiring, and
 * re-charged the lot (#208), while every asset card deducted the whole class
 * contra from its own cost (#214).
 *
 * `fixed_asset_depreciation` records that attribution. It is metadata OVER the
 * ledger, never a parallel one: each row names a share of a credit that already
 * exists on the posted voucher it points at, and the row is written inside the
 * SAME transaction as that voucher. Nothing posted is ever rewritten.
 *
 * ── The legacy back-fill ──
 *
 * Closes posted before this migration carry no attribution. They are back-filled
 * from EVIDENCE, one voucher at a time, and only where the evidence is complete:
 *
 *  1. The voucher is a recognised annual close — the server-side
 *     `annual_close_period_id` stamp (#207), or the documented
 *     `Annual depreciation charge for <period name>` reason, whose period is
 *     then found by that name.
 *  2. Its charge is RE-DERIVED with the same deterministic straight-line
 *     arithmetic that produced it (accumulated at the period end minus
 *     accumulated at the prior period end, per register row). This is a
 *     recomputation of a pure function over unchanged master data, not an
 *     allocation rule invented here.
 *  3. The re-derived per-class total must equal the voucher's posted per-class
 *     credit EXACTLY. Only then are that class's rows written.
 *
 * A voucher — or a single class within it — that does not reconcile to the cent
 * is LEFT UNATTRIBUTED. Nothing is assigned on a guess, and nothing downstream
 * is allowed to read "unattributed" as "zero": a disposal that depends on an
 * unattributed close is REFUSED with a structured error naming the vouchers and
 * amounts, until an operator supplies a validated per-voucher/per-asset
 * allocation (source `operator_allocation`), which must itself reconcile to the
 * voucher's signed class legs exactly. See
 * `fixed-assets/depreciation-attribution.service.ts`.
 *
 * The arithmetic below is a deliberate, frozen COPY of the depreciation engine
 * as it stands today. A migration must reproduce what the ledger actually holds,
 * which is what that engine computed at the time — it must not start producing
 * different numbers because the engine is changed later.
 */

/** The documented reason prefix of an annual-close depreciation voucher. */
const ANNUAL_DEPRECIATION_REASON_PREFIX = 'Annual depreciation charge for ';

/**
 * The documented reason a disposal's catch-up voucher carries, naming the very
 * asset it was charged for (`FixedAssetsService.dispose`). Frozen here for the
 * same reason the arithmetic below is: the migration must recognise the
 * strings the ledger actually holds.
 */
function catchUpReasonFor(assetId: number): string {
  return `Catch-up depreciation on disposal of fixed asset ${assetId}`;
}

/** The contra account of each asset class (ADR-0035). */
const ACCUM_BY_CLASS: Record<string, string> = {
  vehicle: 'ACCUM_DEPRECIATION_VEHICLES',
  it_equipment: 'ACCUM_DEPRECIATION_IT',
  machinery: 'ACCUM_DEPRECIATION_EQUIPMENT',
  furniture: 'ACCUM_DEPRECIATION_FURNITURE',
};

interface FrozenAsset {
  acquisition_date: string;
  cost_base_minor: number;
  useful_life_years: number;
  residual_value_minor: number;
}

/** Frozen copy of the engine's whole-month count. */
function monthsElapsed(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  const months = (ty - fy) * 12 + (tm - fm) + 1;
  return months < 0 ? 0 : months;
}

/** Frozen copy of the engine's accumulated-depreciation computation. */
function accumulatedAsOf(asset: FrozenAsset, asOf: string): number {
  const depreciableBase = asset.cost_base_minor - asset.residual_value_minor;
  if (depreciableBase <= 0 || asset.useful_life_years <= 0) return 0;
  const monthlyRate = depreciableBase / (asset.useful_life_years * 12);
  const elapsed = monthsElapsed(asset.acquisition_date, asOf);
  if (elapsed <= 0) return 0;
  return Math.min(Math.round(monthlyRate * elapsed), depreciableBase);
}

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('fixed_asset_depreciation')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('fixed_asset_id', 'integer', (col) =>
      col.notNull().references('fixed_asset.id'),
    )
    .addColumn('voucher_id', 'integer', (col) =>
      col.notNull().references('voucher.id'),
    )
    .addColumn('amount_minor', 'integer', (col) => col.notNull())
    .addColumn('charge_through_date', 'text', (col) => col.notNull())
    .addColumn('source', 'text', (col) =>
      col
        .notNull()
        .check(
          sql`source IN ('annual_close','disposal_catch_up','disposal_clearing','legacy_backfill','operator_allocation')`,
        ),
    )
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .execute();

  // One attribution per (voucher, asset): a voucher carries a single share for
  // an asset, so a retried write cannot double-count it.
  await db.schema
    .createIndex('idx_fixed_asset_depreciation_voucher_asset')
    .unique()
    .on('fixed_asset_depreciation')
    .columns(['voucher_id', 'fixed_asset_id'])
    .execute();
  await db.schema
    .createIndex('idx_fixed_asset_depreciation_asset')
    .on('fixed_asset_depreciation')
    .column('fixed_asset_id')
    .execute();

  // Append-only (ADR-0009). An attribution row states what an IMMUTABLE posted
  // voucher charged for an asset; letting it be edited or removed would make
  // the ledger's history re-writable through the back door.
  await sql`
    CREATE TRIGGER fixed_asset_depreciation_block_update
    BEFORE UPDATE ON fixed_asset_depreciation
    BEGIN
      SELECT RAISE(ABORT, 'fixed_asset_depreciation is append-only');
    END;
  `.execute(db);
  await sql`
    CREATE TRIGGER fixed_asset_depreciation_block_delete
    BEFORE DELETE ON fixed_asset_depreciation
    BEGIN
      SELECT RAISE(ABORT, 'fixed_asset_depreciation is append-only');
    END;
  `.execute(db);

  await backfillLegacyCloses(db);
  await backfillLegacyDisposals(db);
}

/** @see the file header — evidence-based, exact-reconciliation-only back-fill. */
async function backfillLegacyCloses(db: Kysely<Database>): Promise<void> {
  const assets = await db
    .selectFrom('fixed_asset')
    .select([
      'id',
      'asset_class',
      'acquisition_date',
      'cost_base_minor',
      'useful_life_years',
      'residual_value_minor',
      'acquisition_voucher_id',
      'disposal_voucher_id',
    ])
    .execute();
  if (assets.length === 0) return;

  const closes = await db
    .selectFrom('voucher')
    .select(['id', 'reason', 'annual_close_period_id', 'tax_point_date'])
    .where('posted_at', 'is not', null)
    .where((eb) =>
      eb.or([
        eb('annual_close_period_id', 'is not', null),
        eb('reason', 'like', `${ANNUAL_DEPRECIATION_REASON_PREFIX}%`),
      ]),
    )
    .execute();
  if (closes.length === 0) return;

  const periods = await db
    .selectFrom('reporting_period')
    .select(['id', 'name', 'start_date', 'end_date', 'kind'])
    .execute();

  const now = Math.floor(Date.now() / 1000);

  for (const close of closes) {
    // (1) Which year did this voucher close?
    const period =
      (close.annual_close_period_id !== null
        ? periods.find((p) => p.id === close.annual_close_period_id)
        : undefined) ??
      (close.reason?.startsWith(ANNUAL_DEPRECIATION_REASON_PREFIX)
        ? periods.find(
            (p) =>
              p.name ===
              close.reason!.slice(ANNUAL_DEPRECIATION_REASON_PREFIX.length),
          )
        : undefined);
    if (!period) continue; // no identifiable year ⇒ no evidence ⇒ leave unattributed

    // What the voucher actually posted per class (credit-positive).
    const postedLines = await db
      .selectFrom('voucher_line as vl')
      .innerJoin('account as a', 'a.id', 'vl.account_id')
      .select(['a.code', 'vl.base_amount', 'vl.is_debit'])
      .where('vl.voucher_id', '=', close.id)
      .where('a.code', 'in', Object.values(ACCUM_BY_CLASS))
      .execute();
    const postedByClass = new Map<string, number>();
    for (const l of postedLines) {
      const cls = Object.keys(ACCUM_BY_CLASS).find(
        (c) => ACCUM_BY_CLASS[c] === l.code,
      );
      if (!cls) continue;
      const signed = l.is_debit ? -l.base_amount : l.base_amount;
      postedByClass.set(cls, (postedByClass.get(cls) ?? 0) + signed);
    }
    if (postedByClass.size === 0) continue;

    // (2) Re-derive the split with the same deterministic arithmetic.
    const prior = periods
      .filter((p) => p.kind === period.kind && p.end_date < period.start_date)
      .sort((a, b) => (a.end_date < b.end_date ? 1 : -1))[0];
    const priorEnd = prior ? prior.end_date : null;

    const derived = new Map<string, Array<{ id: number; amount: number }>>();
    for (const a of assets) {
      // HISTORICAL REGISTER MEMBERSHIP, from persisted evidence rather than
      // from today's register. The voucher id is a gapless server-assigned
      // sequence (ADR-0013's hash chain commits to it), so it orders postings
      // durably:
      //  - a register row is created in the SAME transaction as its
      //    acquisition voucher (the registrar's afterPost hook), so an asset
      //    whose acquisition voucher was posted AFTER this close did not exist
      //    when the close ran and cannot be part of it;
      //  - the close skipped every already-retired row, and a row is retired in
      //    the same transaction as its disposal voucher, so a disposal posted
      //    BEFORE this close means the asset was already retired then.
      if (a.acquisition_voucher_id > close.id) continue;
      if (a.disposal_voucher_id !== null && a.disposal_voucher_id < close.id)
        continue;
      const charge = Math.max(
        0,
        accumulatedAsOf(a, period.end_date) -
          (priorEnd === null ? 0 : accumulatedAsOf(a, priorEnd)),
      );
      if (charge === 0) continue;
      const list = derived.get(a.asset_class) ?? [];
      list.push({ id: a.id, amount: charge });
      derived.set(a.asset_class, list);
    }

    // (3) Write only the classes that reconcile to the cent.
    for (const [cls, posted] of postedByClass) {
      const shares = derived.get(cls) ?? [];
      const sum = shares.reduce((s, x) => s + x.amount, 0);
      if (sum !== posted || shares.length === 0) continue;
      await db
        .insertInto('fixed_asset_depreciation')
        .values(
          shares.map((s) => ({
            fixed_asset_id: s.id,
            voucher_id: close.id,
            amount_minor: s.amount,
            charge_through_date: period.end_date,
            source: 'legacy_backfill',
            created_at: now,
          })),
        )
        .execute();
    }
  }
}

/**
 * The two vouchers a disposal posted before this migration existed: the
 * catch-up charge, and the clearing debit that took the asset's accumulated
 * depreciation off the class.
 *
 * Both are movements on an `ACCUM_DEPRECIATION_*` account, so leaving them
 * unattributed would report them as unexplained — and an unexplained movement
 * blocks the year's close and the class's other disposals. Neither is actually
 * unknown, and neither is derived from arithmetic here:
 *
 *  - the clearing leg's owner is PERSISTED: `fixed_asset.disposal_voucher_id`
 *    names the voucher that retired exactly one asset. The attributed amount
 *    is that voucher's own signed net on that asset's class — what the ledger
 *    says, not what the engine would compute;
 *  - the catch-up carries the documented reason that names the same asset id,
 *    the same kind of evidence the annual close's reason prefix already is.
 *
 * Anything not so identified — a disposal voucher no register row points at,
 * two rows pointing at one voucher, a class the asset does not belong to — is
 * left unattributed, to be resolved through an operator allocation. No posted
 * voucher is read for anything but its own lines, and none is altered.
 */
async function backfillLegacyDisposals(db: Kysely<Database>): Promise<void> {
  const disposed = await db
    .selectFrom('fixed_asset')
    .select(['id', 'asset_class', 'disposal_voucher_id'])
    .where((eb) =>
      eb.or([
        eb('disposal_voucher_id', 'is not', null),
        eb('retired_at', 'is not', null),
      ]),
    )
    .execute();
  if (disposed.length === 0) return;

  // A voucher that retires more than one register row does not identify whose
  // depreciation it cleared.
  const ownersPerVoucher = new Map<number, number>();
  for (const a of disposed) {
    if (a.disposal_voucher_id === null) continue;
    ownersPerVoucher.set(
      a.disposal_voucher_id,
      (ownersPerVoucher.get(a.disposal_voucher_id) ?? 0) + 1,
    );
  }

  const now = Math.floor(Date.now() / 1000);

  for (const asset of disposed) {
    const accumCode = ACCUM_BY_CLASS[asset.asset_class];
    if (!accumCode) continue;

    // The two legs are judged on their OWN evidence, independently: a
    // register row that has lost its `disposal_voucher_id` still identifies
    // its catch-up by reason, and each is attributed only if its own evidence
    // names exactly one owner.

    // (a) The clearing leg — owned by whichever register row names it.
    const disposalVoucherId = asset.disposal_voucher_id;
    if (
      disposalVoucherId !== null &&
      ownersPerVoucher.get(disposalVoucherId) === 1
    ) {
      await attributeVoucherClass(db, {
        voucherId: disposalVoucherId,
        assetId: asset.id,
        accumCode,
        now,
      });
    }

    // (b) The catch-up charge, identified by the reason naming this asset.
    const catchUps = await db
      .selectFrom('voucher')
      .select('id')
      .where('posted_at', 'is not', null)
      .where('reason', '=', catchUpReasonFor(asset.id))
      .execute();
    if (catchUps.length !== 1) continue;
    await attributeVoucherClass(db, {
      voucherId: catchUps[0].id,
      assetId: asset.id,
      accumCode,
      now,
    });
  }
}

/**
 * Attribute ONE voucher's whole signed movement on ONE contra account to ONE
 * asset — used where the evidence names a single owner. A no-op when the
 * voucher does not move that account, or already carries attribution.
 */
async function attributeVoucherClass(
  db: Kysely<Database>,
  opts: { voucherId: number; assetId: number; accumCode: string; now: number },
): Promise<void> {
  const existing = await db
    .selectFrom('fixed_asset_depreciation')
    .select('id')
    .where('voucher_id', '=', opts.voucherId)
    .executeTakeFirst();
  if (existing) return;

  const lines = await db
    .selectFrom('voucher_line as vl')
    .innerJoin('account as a', 'a.id', 'vl.account_id')
    .select(['vl.base_amount', 'vl.is_debit'])
    .where('vl.voucher_id', '=', opts.voucherId)
    .where('a.code', '=', opts.accumCode)
    .execute();
  const net = lines.reduce(
    (s, l) => s + (l.is_debit ? -l.base_amount : l.base_amount),
    0,
  );
  if (net === 0) return;

  const voucher = await db
    .selectFrom('voucher')
    .select('tax_point_date')
    .where('id', '=', opts.voucherId)
    .executeTakeFirstOrThrow();

  await db
    .insertInto('fixed_asset_depreciation')
    .values({
      fixed_asset_id: opts.assetId,
      voucher_id: opts.voucherId,
      amount_minor: net,
      charge_through_date: voucher.tax_point_date,
      source: 'legacy_backfill',
      created_at: opts.now,
    })
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('fixed_asset_depreciation').ifExists().execute();
}
