import { IDENTITY_RATE_SOURCE } from '../fx/fx-rate.types';
import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { PostingService } from '../ledger/posting/posting.service';
import {
  DraftVoucher,
  DraftVoucherLine,
  PostedVoucher,
} from '../ledger/voucher/types';
import { AssetClass } from '../plugins/fixed-asset.types';
import { accumulatedDepreciationAsOf } from './depreciation-engine';
import { CLASS_ACCOUNTS } from './fixed-asset-class-map';
import { DepreciationAttributionService } from './depreciation-attribution.service';
import { DisposeAssetDto, FixedAsset, FixedAssetWithBookValue } from './types';

/** Calendar-shaped ISO date. The engine's month arithmetic assumes this form. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A REAL calendar date in ISO form. The shape alone is not enough:
 * `2027-02-30` and `2027-13-01` both match the pattern, and both would feed
 * the engine's month arithmetic a day that does not exist.
 */
function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

/**
 * The as-of cutoff the register reports at: the WHOLE posted ledger.
 *
 * The register has no `asOf` parameter, and cost, depreciation and retirement
 * must be read on ONE basis or the rows contradict themselves — a future-dated
 * acquisition showing its cost while a future-dated close is cut off would
 * report a cost with no depreciation, and cutting depreciation at today while
 * `retired_at` (a wall-clock stamp) already reads as disposed would zero an
 * asset out before its disposal date. Reading everything posted keeps the row
 * consistent with the ledger the same way it always did; a genuine as-of view
 * belongs behind an explicit API parameter, not behind a silent `today()`.
 */
const WHOLE_POSTED_LEDGER = '9999-12-31';

/**
 * FixedAssetsService — register read + the disposal operation (ADR-0035 §6).
 *
 * Disposal posts TWO system-generated vouchers in ONE transaction:
 *   (a) catch-up depreciation — the part of the asset's accumulated
 *       depreciation at the disposal date that the ledger does NOT already
 *       carry FOR THIS ASSET;
 *   (b) the disposal voucher that retires the asset.
 * The register row is then marked retired, in the same transaction, by a
 * guarded update. Period-lock is enforced by PostingService (the disposal date
 * is the tax_point_date of both vouchers).
 *
 * WHAT THE LEDGER ALREADY CARRIES (issue #208). Earlier this class assumed
 * nothing had been posted and charged the full theoretical accumulation on
 * disposal. Once the annual close began posting depreciation, that re-charged
 * every closed year: expenses were overstated and the class contra kept an
 * orphan credit for an asset that had left the books. The figure is now read
 * from {@link DepreciationAttributionService}, which knows which posted
 * depreciation belongs to which asset — not from the class contra balance
 * (that is the whole class, including peers) and not from a date.
 */
@Injectable()
export class FixedAssetsService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly posting: PostingService,
    private readonly attribution: DepreciationAttributionService,
  ) {}

  async list(): Promise<FixedAssetWithBookValue[]> {
    const rows = await this.db
      .selectFrom('fixed_asset')
      .selectAll()
      .orderBy('id')
      .execute();
    if (rows.length === 0) return [];

    const asOf = WHOLE_POSTED_LEDGER;
    const posted = await this.attribution.postedByAsset(
      rows.map((r) => r.id),
      asOf,
    );
    // Reported once for the whole register rather than per row, so N assets
    // cost one scan instead of N.
    const unattributed = await this.attribution.unattributedDepreciation(asOf);

    return rows.map((r) => {
      const blocking = unattributed.filter(
        (u) =>
          u.assetClass === r.asset_class &&
          u.voucherId > r.acquisition_voucher_id &&
          u.taxPointDate >= r.acquisition_date,
      );
      return {
        ...this.mapRow(r),
        book_value_minor: this.bookValue(r, posted.get(r.id) ?? 0),
        unattributed_depreciation_minor: blocking.reduce(
          (s, u) => s + u.unattributedMinor,
          0,
        ),
      };
    });
  }

  /**
   * Book value = this asset's OWN cost less this asset's OWN posted
   * depreciation.
   *
   * It used to net the whole class contra account and subtract that from every
   * asset in the class, so two IT assets each deducted the other's
   * depreciation as well as their own and the register understated the class
   * control balance (issue #214). The per-asset figure comes from the
   * attribution table; where some of the class movement is NOT attributed, the
   * asset still shows only what is evidenced, and the unattributed remainder is
   * reported ALONGSIDE it (`unattributed_depreciation_minor`) rather than being
   * guessed at or silently dropped.
   *
   * A RETIRED asset has left the books: its cost and its accumulated
   * depreciation were both removed by the disposal voucher, so its book value
   * is zero — never its original cost resurrected.
   */
  private bookValue(
    row: { cost_base_minor: number; retired_at: number | null },
    postedDepreciationMinor: number,
  ): number {
    if (row.retired_at !== null) return 0;
    return row.cost_base_minor - postedDepreciationMinor;
  }

  async dispose(
    id: number,
    dto: DisposeAssetDto,
  ): Promise<{
    depreciationVoucher: PostedVoucher | null;
    disposalVoucher: PostedVoucher;
  }> {
    const asset = await this.db
      .selectFrom('fixed_asset')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!asset) throw new NotFoundException(`Fixed asset ${id} not found`);
    if (asset.retired_at !== null)
      throw new ConflictException(`Fixed asset ${id} is already retired`);

    // The disposal date drives BOTH vouchers' tax point, the catch-up
    // arithmetic and the as-of cutoff on everything read below, so it is
    // validated before any of that runs.
    if (!isCalendarDate(dto.disposal_date)) {
      throw new BadRequestException(
        `disposal_date must be an ISO date (YYYY-MM-DD), got "${dto.disposal_date}"`,
      );
    }
    if (dto.disposal_date < asset.acquisition_date) {
      throw new BadRequestException(
        `Cannot dispose of fixed asset ${id} on ${dto.disposal_date}: it was acquired on ${asset.acquisition_date}`,
      );
    }

    const cls = asset.asset_class as AssetClass;
    const { fixedAssetCode, accumDepreciationCode } = CLASS_ACCOUNTS[cls];
    const depreciable = {
      acquisition_date: asset.acquisition_date,
      cost_base_minor: asset.cost_base_minor,
      useful_life_years: asset.useful_life_years,
      residual_value_minor: asset.residual_value_minor,
    };

    // Refuse rather than guess. If some of this class's posted depreciation is
    // not attributed to individual assets, this asset's share of it is
    // genuinely unknown — and treating it as zero is precisely the #208 bug:
    // the catch-up would re-charge it and the retirement would leave the
    // unattributed part behind as an orphan credit. The thrown error names the
    // vouchers and the supported allocation route.
    await this.attribution.assertAttributable(asset, dto.disposal_date);

    // (a) Catch-up: what this asset SHOULD have accumulated by the disposal
    //     date, less what the ledger has already posted FOR THIS ASSET as of
    //     that same date.
    const postedForAsset = await this.attribution.postedForAsset(
      id,
      dto.disposal_date,
    );
    const theoretical = accumulatedDepreciationAsOf(
      depreciable,
      dto.disposal_date,
    );
    const catchUp = Math.max(0, theoretical - postedForAsset);
    // What retirement must clear is what the ledger actually carries for this
    // asset plus what is about to be posted for it — not the engine's
    // theoretical figure. Where an already-posted close charged MORE than the
    // engine now computes (immutable history, e.g. a life shortened after the
    // close), the catch-up floors at zero and the retirement still removes the
    // posted amount in full, so no orphan contra is left behind either way.
    const accumulated = postedForAsset + catchUp;

    const proceeds = dto.proceeds_minor ?? 0;
    const netBookValue = asset.cost_base_minor - accumulated;
    // Gain (proceeds > NBV) → credit GAIN_LOSS; loss → debit GAIN_LOSS.
    const gainLoss = proceeds - netBookValue;

    const drafts: DraftVoucher[] = [];

    if (catchUp > 0) {
      drafts.push({
        tax_point_date: dto.disposal_date,
        reason: `Catch-up depreciation on disposal of fixed asset ${id}`,
        lines: [
          this.line('DEPRECIATION_EXPENSE', catchUp, true),
          this.line(accumDepreciationCode, catchUp, false),
        ],
      });
    }

    // (b) Disposal voucher: Dr Bank(proceeds), Dr ACCUM(accumulated),
    //     Cr FIXED_ASSETS(cost), balance to GAIN_LOSS.
    const disposalLines: DraftVoucherLine[] = [];
    if (proceeds > 0) disposalLines.push(this.line('BANK_EUR', proceeds, true));
    if (accumulated > 0)
      disposalLines.push(this.line(accumDepreciationCode, accumulated, true));
    disposalLines.push(this.line(fixedAssetCode, asset.cost_base_minor, false));
    if (gainLoss > 0) {
      disposalLines.push(
        this.line('GAIN_LOSS_ON_ASSET_DISPOSAL', gainLoss, false),
      ); // gain (credit)
    } else if (gainLoss < 0) {
      disposalLines.push(
        this.line('GAIN_LOSS_ON_ASSET_DISPOSAL', -gainLoss, true),
      ); // loss (debit)
    }
    drafts.push({
      tax_point_date: dto.disposal_date,
      reason: `Disposal of fixed asset ${id}`,
      lines: disposalLines,
    });

    const posted = await this.posting.postVouchersAtomic(drafts, {
      afterPost: async (trx, vouchers) => {
        const disposalVoucher = vouchers[vouchers.length - 1];

        // Attribution is written in the SAME transaction as the vouchers
        // carrying it: a movement and the record of whose movement it is can
        // never exist apart.
        //
        // BOTH legs are attributed, with their signs. The catch-up adds to
        // this asset's accumulated depreciation; the disposal's clearing debit
        // takes all of it away again. Recording only the first would leave the
        // clearing leg looking like an unexplained movement on the class, and
        // a signed model that skipped it would not net to zero for a retired
        // asset.
        await this.attribution.attributeTx(trx, [
          ...(catchUp > 0
            ? [
                {
                  fixedAssetId: id,
                  voucherId: vouchers[0].id,
                  amountMinor: catchUp,
                  chargeThroughDate: dto.disposal_date,
                  source: 'disposal_catch_up' as const,
                },
              ]
            : []),
          ...(accumulated > 0
            ? [
                {
                  fixedAssetId: id,
                  voucherId: disposalVoucher.id,
                  amountMinor: -accumulated,
                  chargeThroughDate: dto.disposal_date,
                  source: 'disposal_clearing' as const,
                },
              ]
            : []),
        ]);

        // GUARDED retirement. The `retired_at IS NULL` predicate, evaluated
        // inside this transaction, is what makes a retried or concurrent
        // disposal safe: the second one matches no row, throws here, and takes
        // its own catch-up and disposal vouchers down with it. The pre-flight
        // check above is read OUTSIDE the transaction and cannot do this on
        // its own.
        const updated = await trx
          .updateTable('fixed_asset')
          .set({
            retired_at: Math.floor(Date.now() / 1000),
            disposal_voucher_id: disposalVoucher.id,
          })
          .where('id', '=', id)
          .where('retired_at', 'is', null)
          .executeTakeFirst();
        if (Number(updated.numUpdatedRows ?? 0) !== 1) {
          throw new ConflictException(`Fixed asset ${id} is already retired`);
        }
      },
    });

    const disposalVoucher = posted[posted.length - 1];
    const depreciationVoucher = catchUp > 0 ? posted[0] : null;
    return { depreciationVoucher, disposalVoucher };
  }

  private line(
    account_code: string,
    base_amount: number,
    is_debit: boolean,
  ): DraftVoucherLine {
    return {
      account_code,
      amount: base_amount,
      currency: 'EUR',
      base_amount,
      // A depreciation charge is booked wholly in base currency: no rate was
      // applied, and that is recorded rather than left blank (issue #203).
      fx_rate: 1,
      fx_rate_date: null,
      fx_rate_source: IDENTITY_RATE_SOURCE,
      vat_code: null,
      is_debit,
    };
  }

  private mapRow(r: {
    id: number;
    name: string;
    asset_class: string;
    acquisition_voucher_id: number;
    acquisition_date: string;
    cost_base_minor: number;
    useful_life_years: number;
    residual_value_minor: number;
    retired_at: number | null;
    disposal_voucher_id: number | null;
  }): FixedAsset {
    return {
      id: r.id,
      name: r.name,
      asset_class: r.asset_class,
      acquisition_voucher_id: r.acquisition_voucher_id,
      acquisition_date: r.acquisition_date,
      cost_base_minor: r.cost_base_minor,
      useful_life_years: r.useful_life_years,
      residual_value_minor: r.residual_value_minor,
      retired_at: r.retired_at,
      disposal_voucher_id: r.disposal_voucher_id,
    };
  }
}
