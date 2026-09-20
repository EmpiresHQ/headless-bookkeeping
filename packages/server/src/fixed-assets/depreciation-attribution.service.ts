import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { AssetClass } from '../plugins/fixed-asset.types';
import { AuditLogService } from '../audit-log/audit-log.service';
import { CLASS_ACCOUNTS } from './fixed-asset-class-map';

/** Where an attribution row came from. */
export type AttributionSource =
  | 'annual_close'
  | 'disposal_catch_up'
  | 'legacy_backfill'
  | 'operator_allocation';

/** One asset's share of one voucher's ACCUM_DEPRECIATION_* movement. */
export interface AttributionRow {
  fixedAssetId: number;
  voucherId: number;
  /** Credit-positive minor units (a charge is positive). */
  amountMinor: number;
  chargeThroughDate: string;
  source: AttributionSource;
}

/**
 * A posted movement on an ACCUM_DEPRECIATION_* account that this kernel cannot
 * attribute to individual assets — what an operator must resolve before a
 * dependent disposal or book value can be computed.
 */
export interface UnattributedDepreciation {
  voucherId: number;
  voucherReason: string | null;
  taxPointDate: string;
  assetClass: AssetClass;
  /** Credit-positive: posted on the class by this voucher, minus attributed. */
  unattributedMinor: number;
  /** Why it could not be attributed — for the operator, and for the tests. */
  cause: 'unattributed_posting' | 'partial_reversal';
}

/** The operator's proposed split of ONE voucher's contra movement. */
export interface AllocationRequest {
  voucherId: number;
  allocations: Array<{ fixedAssetId: number; amountMinor: number }>;
}

/**
 * DepreciationAttributionService — which POSTED depreciation belongs to WHICH
 * asset (issue #208).
 *
 * The annual close posts one voucher whose ACCUM_DEPRECIATION_* lines are
 * aggregated per asset CLASS, and an operator may post to those accounts by
 * hand as well. The ledger alone therefore cannot say how much of a class's
 * accumulated depreciation is one asset's. Without that, disposal had to assume
 * NOTHING had been posted and re-charged the whole theoretical accumulation
 * (#208), and every asset card deducted the entire class contra (#214).
 *
 * This service owns `fixed_asset_depreciation`: append-only attribution
 * metadata OVER the ledger, never a parallel ledger. Every row names a share of
 * a movement that already exists on the posted voucher it points at, and is
 * written INSIDE that voucher's transaction.
 *
 * Three rules run through everything here:
 *
 *  1. **Evidence, never a guess.** An amount is attributed only where the
 *     evidence identifies the asset. What is not attributed stays visibly
 *     unattributed.
 *  2. **Unattributed is never read as zero.** A disposal that depends on an
 *     unattributed movement is REFUSED (see {@link assertAttributable}) rather
 *     than re-charging depreciation the ledger already carries. The supported
 *     way forward is {@link allocate}, which validates a proposed split against
 *     the voucher's signed class legs.
 *  3. **As-of, always.** Every read takes the date it is being asked about. A
 *     reversal booked in a LATER period must not erase depreciation that was
 *     genuinely posted as of an earlier one.
 */
@Injectable()
export class DepreciationAttributionService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly auditLog: AuditLogService,
  ) {}

  private static accumCodes(): string[] {
    return (Object.keys(CLASS_ACCOUNTS) as AssetClass[]).map(
      (c) => CLASS_ACCOUNTS[c].accumDepreciationCode,
    );
  }

  private static classForAccum(code: string): AssetClass | undefined {
    return (Object.keys(CLASS_ACCOUNTS) as AssetClass[]).find(
      (c) => CLASS_ACCOUNTS[c].accumDepreciationCode === code,
    );
  }

  /**
   * Persist attribution rows inside an OPEN posting transaction.
   *
   * Callers MUST pass the transaction the voucher is being posted in (never
   * `this.db`): an attributed charge and its ledger lines have to commit or
   * roll back together, and a read/write through `this.db` inside an open
   * transaction deadlocks better-sqlite3's single connection.
   */
  async attributeTx(
    trx: Kysely<Database>,
    rows: AttributionRow[],
  ): Promise<void> {
    const nonZero = rows.filter((r) => r.amountMinor !== 0);
    if (nonZero.length === 0) return;
    const now = Math.floor(Date.now() / 1000);
    await trx
      .insertInto('fixed_asset_depreciation')
      .values(
        nonZero.map((r) => ({
          fixed_asset_id: r.fixedAssetId,
          voucher_id: r.voucherId,
          amount_minor: r.amountMinor,
          charge_through_date: r.chargeThroughDate,
          source: r.source,
          created_at: now,
        })),
      )
      .execute();
  }

  /**
   * Depreciation POSTED for these assets as of `asOf`, per asset id.
   *
   * ── The as-of cutoff and reversals ──
   *
   * A row counts when the voucher carrying it is posted and dated on or before
   * `asOf`. Its REVERSAL is a separate voucher with its own date, and it is
   * subtracted only when it too is posted on or before `asOf`. A reversal
   * booked in a LATER period therefore does not erase depreciation that really
   * was posted as of the earlier date — the same cutoff the annual report
   * applies to its own period window, so a disposal and the report of an
   * already-filed year read the same history.
   *
   * ── Signed legs, not "any reversal exists" ──
   *
   * A reversal is credited back only for what it actually reverses: the
   * reversing voucher's own signed ACCUM_* net for the class must equal the
   * negative of the original's signed ACCUM_* net for that class. A voucher
   * that only partly offsets the original nets nothing away on a proportional
   * guess — it makes that class AMBIGUOUS, reported by
   * {@link unattributedDepreciation} and refused by {@link assertAttributable}.
   */
  async postedByAsset(
    assetIds: number[],
    asOf: string,
  ): Promise<Map<number, number>> {
    const result = new Map<number, number>(assetIds.map((id) => [id, 0]));
    if (assetIds.length === 0) return result;

    const rows = await this.db
      .selectFrom('fixed_asset_depreciation as fad')
      .innerJoin('voucher as v', 'v.id', 'fad.voucher_id')
      .innerJoin('fixed_asset as fa', 'fa.id', 'fad.fixed_asset_id')
      .select([
        'fad.fixed_asset_id',
        'fad.voucher_id',
        'fad.amount_minor',
        'fa.asset_class',
      ])
      .where('fad.fixed_asset_id', 'in', assetIds)
      .where('v.posted_at', 'is not', null)
      .where('v.tax_point_date', '<=', asOf)
      .execute();
    if (rows.length === 0) return result;

    const voucherIds = [...new Set(rows.map((r) => r.voucher_id))];
    const { fullyReversed } = await this.reversalState(voucherIds, asOf);

    for (const r of rows) {
      if (fullyReversed.get(r.voucher_id)?.has(r.asset_class as AssetClass))
        continue;
      result.set(
        r.fixed_asset_id,
        (result.get(r.fixed_asset_id) ?? 0) + r.amount_minor,
      );
    }
    return result;
  }

  /** {@link postedByAsset} for a single asset. */
  async postedForAsset(assetId: number, asOf: string): Promise<number> {
    return (await this.postedByAsset([assetId], asOf)).get(assetId) ?? 0;
  }

  /**
   * How `voucherIds` stand against their posted reversals as of `asOf`:
   * classes cancelled EXACTLY (so the charge no longer stands), and classes
   * offset only PARTLY (so what is still standing cannot be trusted to match
   * the attribution written for it).
   */
  private async reversalState(
    voucherIds: number[],
    asOf: string,
  ): Promise<{
    fullyReversed: Map<number, Set<AssetClass>>;
    partiallyReversed: Map<number, Map<AssetClass, number>>;
  }> {
    const fullyReversed = new Map<number, Set<AssetClass>>();
    const partiallyReversed = new Map<number, Map<AssetClass, number>>();
    if (voucherIds.length === 0) return { fullyReversed, partiallyReversed };

    const originals = await this.accumNetByVoucher(voucherIds);
    const reversals = await this.db
      .selectFrom('voucher')
      .select(['id', 'reverses_id'])
      .where('reverses_id', 'in', voucherIds)
      .where('posted_at', 'is not', null)
      .where('tax_point_date', '<=', asOf)
      .execute();
    if (reversals.length === 0) return { fullyReversed, partiallyReversed };

    const reversalNets = await this.accumNetByVoucher(
      reversals.map((r) => r.id),
    );
    const byOriginal = new Map<number, Map<AssetClass, number>>();
    for (const r of reversals) {
      if (r.reverses_id === null) continue;
      const net = reversalNets.get(r.id);
      if (!net) continue;
      const acc =
        byOriginal.get(r.reverses_id) ?? new Map<AssetClass, number>();
      for (const [cls, v] of net) acc.set(cls, (acc.get(cls) ?? 0) + v);
      byOriginal.set(r.reverses_id, acc);
    }

    for (const [voucherId, byClass] of originals) {
      const rev = byOriginal.get(voucherId);
      if (!rev) continue;
      for (const [cls, net] of byClass) {
        const r = rev.get(cls) ?? 0;
        if (r === 0 || net === 0) continue;
        if (r === -net) {
          const set = fullyReversed.get(voucherId) ?? new Set<AssetClass>();
          set.add(cls);
          fullyReversed.set(voucherId, set);
        } else {
          const m =
            partiallyReversed.get(voucherId) ?? new Map<AssetClass, number>();
          m.set(cls, r);
          partiallyReversed.set(voucherId, m);
        }
      }
    }
    return { fullyReversed, partiallyReversed };
  }

  /** Signed credit-positive ACCUM_* net per class, per voucher. */
  private async accumNetByVoucher(
    voucherIds: number[],
    executor: Kysely<Database> = this.db,
  ): Promise<Map<number, Map<AssetClass, number>>> {
    const out = new Map<number, Map<AssetClass, number>>();
    if (voucherIds.length === 0) return out;
    const lines = await executor
      .selectFrom('voucher_line as vl')
      .innerJoin('account as a', 'a.id', 'vl.account_id')
      .select(['vl.voucher_id', 'a.code', 'vl.base_amount', 'vl.is_debit'])
      .where('vl.voucher_id', 'in', voucherIds)
      .where('a.code', 'in', DepreciationAttributionService.accumCodes())
      .execute();
    for (const l of lines) {
      const cls = DepreciationAttributionService.classForAccum(l.code);
      if (!cls) continue;
      const signed = l.is_debit ? -l.base_amount : l.base_amount;
      const m = out.get(l.voucher_id) ?? new Map<AssetClass, number>();
      m.set(cls, (m.get(cls) ?? 0) + signed);
      out.set(l.voucher_id, m);
    }
    return out;
  }

  /**
   * EVERY posted movement on an ACCUM_DEPRECIATION_* account, dated on or
   * before `asOf`, that is not attributed to individual assets.
   *
   * Deliberately NOT restricted to recognised annual closes. A plain
   * hand-posted `Dr DEPRECIATION_EXPENSE / Cr ACCUM_DEPRECIATION_IT` is exactly
   * how issue #214's reproduction charges its two assets, and an unattributed
   * movement is no less unknown for having no close marker on it: ignoring it
   * would overstate both asset cards and let a disposal charge it a second
   * time. A charge and a correction are the same problem here.
   *
   * What is NOT flagged, because it is already accounted for:
   *  - a **disposal voucher's clearing leg** — a debit on the class that
   *    retires exactly what the register says was accumulated for the asset
   *    being retired (`fixed_asset.disposal_voucher_id` names that voucher).
   *    It removes attributed depreciation; it is not a fresh charge;
   *  - an **acquisition** — a capex voucher touches `FIXED_ASSETS_*`, never the
   *    contra account, so it never appears here at all;
   *  - a **clean full reversal** of an attributed voucher, whose signed class
   *    leg exactly cancels the original. Both sides are then netted by
   *    {@link postedByAsset} and nothing is left standing to attribute.
   *
   * A PARTIAL reversal is flagged (`partial_reversal`): what remains standing
   * on the class no longer matches the attribution written for it, and no rule
   * here can say which asset the remainder belongs to.
   */
  async unattributedDepreciation(
    asOf: string,
  ): Promise<UnattributedDepreciation[]> {
    const touching = await this.db
      .selectFrom('voucher as v')
      .innerJoin('voucher_line as vl', 'vl.voucher_id', 'v.id')
      .innerJoin('account as a', 'a.id', 'vl.account_id')
      .select(['v.id', 'v.reason', 'v.tax_point_date', 'v.reverses_id'])
      .distinct()
      .where('v.posted_at', 'is not', null)
      .where('v.tax_point_date', '<=', asOf)
      .where('a.code', 'in', DepreciationAttributionService.accumCodes())
      .execute();
    if (touching.length === 0) return [];

    const ids = touching.map((v) => v.id);
    const postedByVoucher = await this.accumNetByVoucher(ids);
    const attributed = await this.attributedByVoucherClass(ids);
    const { fullyReversed, partiallyReversed } = await this.reversalState(
      ids,
      asOf,
    );

    // The vouchers that RETIRE an asset: their contra debit is the accounted-for
    // removal of that asset's attributed depreciation, not a movement in search
    // of an owner.
    const disposalVoucherIds = new Set(
      (
        await this.db
          .selectFrom('fixed_asset')
          .select('disposal_voucher_id')
          .where('disposal_voucher_id', 'is not', null)
          .execute()
      ).map((r) => r.disposal_voucher_id as number),
    );
    // A voucher that cleanly and fully reverses another is accounted for on the
    // original's side; it must not be reported again as a movement of its own.
    const cleanReversalIds = new Set<number>();
    for (const v of touching) {
      if (v.reverses_id === null) continue;
      const originalNet = postedByVoucher.get(v.reverses_id);
      const ownNet = postedByVoucher.get(v.id);
      if (!originalNet || !ownNet) continue;
      const cancelsEverything = [...ownNet.entries()].every(
        ([cls, net]) => (originalNet.get(cls) ?? 0) === -net,
      );
      if (cancelsEverything) cleanReversalIds.add(v.id);
    }

    const out: UnattributedDepreciation[] = [];
    for (const v of touching) {
      if (disposalVoucherIds.has(v.id)) continue;
      if (cleanReversalIds.has(v.id)) continue;
      const byClass = postedByVoucher.get(v.id);
      if (!byClass) continue;
      for (const [cls, postedMinor] of byClass) {
        if (postedMinor === 0) continue;
        if (fullyReversed.get(v.id)?.has(cls)) continue;
        const attributedMinor = attributed.get(v.id)?.get(cls) ?? 0;
        const partial = partiallyReversed.get(v.id)?.get(cls);
        if (partial !== undefined) {
          out.push({
            voucherId: v.id,
            voucherReason: v.reason,
            taxPointDate: v.tax_point_date,
            assetClass: cls,
            unattributedMinor: postedMinor + partial - attributedMinor,
            cause: 'partial_reversal',
          });
          continue;
        }
        if (postedMinor !== attributedMinor) {
          out.push({
            voucherId: v.id,
            voucherReason: v.reason,
            taxPointDate: v.tax_point_date,
            assetClass: cls,
            unattributedMinor: postedMinor - attributedMinor,
            cause: 'unattributed_posting',
          });
        }
      }
    }
    return out;
  }

  /**
   * Σ attributed per class over a set of vouchers — what part of those
   * vouchers' contra movement IS pinned to individual assets. The annual close
   * uses it to tell an attributed close apart from a legacy one that still has
   * to be netted at class level.
   */
  async attributedByClass(
    voucherIds: number[],
  ): Promise<Map<AssetClass, number>> {
    const perVoucher = await this.attributedByVoucherClass(voucherIds);
    const out = new Map<AssetClass, number>();
    for (const byClass of perVoucher.values()) {
      for (const [cls, v] of byClass) out.set(cls, (out.get(cls) ?? 0) + v);
    }
    return out;
  }

  /** Σ attributed per (voucher, class). */
  private async attributedByVoucherClass(
    voucherIds: number[],
    executor: Kysely<Database> = this.db,
  ): Promise<Map<number, Map<AssetClass, number>>> {
    const out = new Map<number, Map<AssetClass, number>>();
    if (voucherIds.length === 0) return out;
    const rows = await executor
      .selectFrom('fixed_asset_depreciation as fad')
      .innerJoin('fixed_asset as fa', 'fa.id', 'fad.fixed_asset_id')
      .select(['fad.voucher_id', 'fad.amount_minor', 'fa.asset_class'])
      .where('fad.voucher_id', 'in', voucherIds)
      .execute();
    for (const r of rows) {
      const cls = r.asset_class as AssetClass;
      const m = out.get(r.voucher_id) ?? new Map<AssetClass, number>();
      m.set(cls, (m.get(cls) ?? 0) + r.amount_minor);
      out.set(r.voucher_id, m);
    }
    return out;
  }

  /**
   * The unattributed movements that specifically bear on one asset: its class,
   * posted while the asset was in the register and within its lifetime.
   *
   * Membership comes from the persisted voucher sequence (see migration 075):
   * a register row is created in the same transaction as its acquisition
   * voucher, so a movement posted BEFORE that voucher cannot concern the asset.
   * An asset bought after an ambiguous legacy year is not held hostage by it.
   */
  async blockingFor(
    asset: {
      id: number;
      asset_class: string;
      acquisition_voucher_id: number;
      acquisition_date: string;
    },
    asOf: string,
  ): Promise<UnattributedDepreciation[]> {
    const all = await this.unattributedDepreciation(asOf);
    if (all.length === 0) return [];
    return all.filter(
      (u) =>
        u.assetClass === asset.asset_class &&
        u.voucherId > asset.acquisition_voucher_id &&
        u.taxPointDate >= asset.acquisition_date,
    );
  }

  /**
   * Refuse to compute anything for `asset` while a contra movement it could be
   * part of is unattributed — the rule that stops "unattributed" being read as
   * "nothing was posted for this asset", which would reproduce #208 with a
   * warning attached and leave an orphan contra balance behind.
   *
   * The error names every blocking voucher and amount, and the supported way
   * out ({@link allocate}), so it is actionable rather than a dead end.
   */
  async assertAttributable(
    asset: {
      id: number;
      asset_class: string;
      acquisition_voucher_id: number;
      acquisition_date: string;
    },
    asOf: string,
  ): Promise<void> {
    const blocking = await this.blockingFor(asset, asOf);
    if (blocking.length === 0) return;
    throw new BadRequestException({
      message:
        `Cannot compute depreciation for fixed asset ${asset.id}: ` +
        `${blocking.length} posted voucher(s) move ${asset.asset_class} ` +
        `accumulated depreciation that is not attributed to individual ` +
        `assets, so how much of it belongs to this asset is unknown. Supply ` +
        `a validated allocation for each voucher listed below ` +
        `(POST /api/fixed-assets/depreciation-allocations) and retry.`,
      error: 'depreciation_attribution_required',
      fixedAssetId: asset.id,
      assetClass: asset.asset_class,
      unattributed: blocking.map((b) => ({
        voucherId: b.voucherId,
        voucherReason: b.voucherReason,
        taxPointDate: b.taxPointDate,
        unattributedMinor: b.unattributedMinor,
        cause: b.cause,
      })),
    });
  }

  /**
   * Record an operator-supplied split of ONE posted voucher's contra movement.
   *
   * This is the supported recovery path for a legacy close, a hand-posted
   * depreciation charge or any other unattributed movement, and it is
   * validated rather than trusted:
   *
   *  - the voucher must be posted and must actually move an ACCUM_* account;
   *  - every named asset must exist, belong to a class the voucher moves, and
   *    have been in the register when the voucher was posted
   *    (`acquisition_voucher_id < voucherId`) — the same persisted membership
   *    evidence the migration uses;
   *  - every amount must be a non-zero whole number of minor units with the
   *    SAME SIGN as the class movement, so two offsetting inflations cannot sum
   *    to the right total;
   *  - for EVERY class the voucher moves, the allocation must reconcile to the
   *    voucher's SIGNED class net EXACTLY. Under-allocation would leave the
   *    class ambiguous while looking resolved; over-allocation would attribute
   *    more than was ever posted. Both are refused, naming the figures;
   *  - a class that already carries a complete attribution cannot be
   *    re-allocated: the rows are append-only (ADR-0009), and re-splitting
   *    settled history is a correction to be made in the ledger, not here. A
   *    voucher that is only PARTLY resolved — the migration back-fills the
   *    classes that reconciled and leaves the rest — stays resolvable for the
   *    classes that are still unattributed, without disturbing the rows
   *    already written.
   *
   * The remaining-amount read, the reconciliation, the rows and the
   * `audit_log` entry all share ONE transaction, so two concurrent requests
   * splitting the same class across disjoint assets cannot both succeed.
   */
  async allocate(request: AllocationRequest): Promise<{ written: number }> {
    if (request.allocations.length === 0) {
      throw new BadRequestException(
        'An allocation must name at least one asset',
      );
    }
    const seen = new Set<number>();
    for (const a of request.allocations) {
      if (!Number.isInteger(a.amountMinor) || a.amountMinor === 0) {
        throw new BadRequestException(
          `Allocation for asset ${a.fixedAssetId} must be a non-zero whole number of minor units`,
        );
      }
      if (seen.has(a.fixedAssetId)) {
        throw new BadRequestException(
          `Asset ${a.fixedAssetId} appears more than once in the allocation`,
        );
      }
      seen.add(a.fixedAssetId);
    }

    // EVERYTHING below — the remaining-amount read, the reconciliation and the
    // write — happens inside ONE transaction, on that transaction's executor.
    // Validating first and writing after would let two concurrent requests
    // that split the same voucher across DISJOINT assets both pass their
    // checks and both write: the UNIQUE (voucher, asset) index would not
    // collide, and the class would end up attributed twice over. Re-reading
    // what is still unattributed inside the transaction is what makes exactly
    // one of them win.
    return this.db.transaction().execute(async (trx) => {
      const voucher = await trx
        .selectFrom('voucher')
        .select(['id', 'reason', 'tax_point_date', 'posted_at'])
        .where('id', '=', request.voucherId)
        .executeTakeFirst();
      if (!voucher || voucher.posted_at === null) {
        throw new BadRequestException(
          `Voucher ${request.voucherId} is not a posted voucher`,
        );
      }

      const postedByClass =
        (await this.accumNetByVoucher([voucher.id], trx)).get(voucher.id) ??
        new Map<AssetClass, number>();
      if ([...postedByClass.values()].every((net) => net === 0)) {
        throw new BadRequestException(
          `Voucher ${voucher.id} moves no accumulated-depreciation account, so there is nothing to allocate`,
        );
      }

      // What is STILL unattributed on each class, read inside the transaction.
      // A multi-class voucher may be partly resolved already — the migration
      // back-fills only the classes that reconciled — and the class that is
      // still ambiguous has to remain resolvable on its own. So an allocation
      // addresses the classes named in its payload; the others are left
      // exactly as they are, rows and all.
      const attributed =
        (await this.attributedByVoucherClass([voucher.id], trx)).get(
          voucher.id,
        ) ?? new Map<AssetClass, number>();
      const remainingByClass = new Map<AssetClass, number>();
      for (const [cls, posted] of postedByClass) {
        const rest = posted - (attributed.get(cls) ?? 0);
        if (rest !== 0) remainingByClass.set(cls, rest);
      }

      const assets = await trx
        .selectFrom('fixed_asset')
        .select(['id', 'asset_class', 'acquisition_voucher_id'])
        .where('id', 'in', [...seen])
        .execute();
      const byId = new Map(assets.map((a) => [a.id, a]));

      const proposedByClass = new Map<AssetClass, number>();
      for (const a of request.allocations) {
        const asset = byId.get(a.fixedAssetId);
        if (!asset) {
          throw new BadRequestException(
            `Fixed asset ${a.fixedAssetId} not found`,
          );
        }
        const cls = asset.asset_class as AssetClass;
        if ((postedByClass.get(cls) ?? 0) === 0) {
          throw new BadRequestException(
            `Fixed asset ${a.fixedAssetId} is ${cls}, which voucher ${voucher.id} does not move`,
          );
        }
        const remaining = remainingByClass.get(cls);
        if (remaining === undefined) {
          throw new BadRequestException(
            `Voucher ${voucher.id} already has a complete attribution for ${cls}; attribution rows are append-only and cannot be re-split`,
          );
        }
        if (Math.sign(a.amountMinor) !== Math.sign(remaining)) {
          throw new BadRequestException(
            `Allocation for asset ${a.fixedAssetId} has the opposite sign to the ${cls} movement on voucher ${voucher.id}`,
          );
        }
        // Historical register membership, from the persisted voucher sequence.
        if (asset.acquisition_voucher_id > voucher.id) {
          throw new BadRequestException(
            `Fixed asset ${a.fixedAssetId} was acquired after voucher ${voucher.id} was posted, so that voucher cannot have charged it`,
          );
        }
        proposedByClass.set(
          cls,
          (proposedByClass.get(cls) ?? 0) + a.amountMinor,
        );
      }

      // Exact reconciliation, per class named. Under-allocation would leave a
      // class ambiguous while looking resolved; over-allocation would attribute
      // more than the voucher ever posted.
      for (const [cls, proposed] of proposedByClass) {
        const remaining = remainingByClass.get(cls) ?? 0;
        if (proposed !== remaining) {
          throw new BadRequestException(
            `Allocation for ${cls} on voucher ${voucher.id} is ${proposed}, but ${remaining} is unattributed; an allocation must reconcile to the unattributed class total exactly`,
          );
        }
      }

      const rows: AttributionRow[] = request.allocations.map((a) => ({
        fixedAssetId: a.fixedAssetId,
        voucherId: voucher.id,
        amountMinor: a.amountMinor,
        chargeThroughDate: voucher.tax_point_date,
        source: 'operator_allocation' as const,
      }));

      await this.attributeTx(trx, rows);
      await this.auditLog.record(
        {
          actor: 'operator',
          action: 'fixed_asset.depreciation_allocated',
          outcome: 'success',
          target_type: 'voucher',
          target_id: voucher.id,
          detail: {
            voucher_reason: voucher.reason,
            allocations: request.allocations,
          },
        },
        trx,
      );

      return { written: rows.length };
    });
  }
}
