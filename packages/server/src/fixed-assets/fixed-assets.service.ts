import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { PostingService } from '../ledger/posting/posting.service';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import {
  DraftVoucher,
  DraftVoucherLine,
  PostedVoucher,
} from '../ledger/voucher/types';
import { AssetClass } from '../plugins/fixed-asset.types';
import {
  accumulatedDepreciationAsOf,
  depreciationCharge,
} from './depreciation-engine';
import { CLASS_ACCOUNTS } from './fixed-asset-class-map';
import { DisposeAssetDto, FixedAsset, FixedAssetWithBookValue } from './types';

/**
 * FixedAssetsService — register read + the disposal operation (ADR-0035 §6).
 *
 * Disposal posts TWO system-generated vouchers in ONE transaction:
 *   (a) catch-up depreciation from the last close (here: from the asset's last
 *       recognised accumulated point, i.e. acquisition for v1 — there is no
 *       prior depreciation posting in this PRD's scope) up to the disposal date;
 *   (b) the disposal voucher that retires the asset.
 * The register row is then marked retired. Period-lock is enforced by
 * PostingService (the disposal date is the tax_point_date of both vouchers).
 */
@Injectable()
export class FixedAssetsService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly posting: PostingService,
    private readonly ledgerBalance: LedgerBalanceService,
  ) {}

  async list(): Promise<FixedAssetWithBookValue[]> {
    const rows = await this.db
      .selectFrom('fixed_asset')
      .selectAll()
      .orderBy('id')
      .execute();
    return Promise.all(
      rows.map(async (r) => ({
        ...this.mapRow(r),
        book_value_minor: await this.bookValue(r),
      })),
    );
  }

  /** Book value = cost − accumulated depreciation posted to the contra account. */
  private async bookValue(row: {
    id: number;
    cost_base_minor: number;
    asset_class: string;
  }): Promise<number> {
    const { accumDepreciationCode } =
      CLASS_ACCOUNTS[row.asset_class as AssetClass];
    // Σ depreciation = magnitude netted over the contra account for this asset's vouchers.
    // The contra account is per-class, so net over ALL its lines is the class total; for a
    // single-asset deployment that equals this asset. (Multi-asset attribution by voucher set
    // is a refinement; v1 nets the class contra — see Further Notes in the PRD.)
    const net = await this.ledgerBalance.getLedgerNet(
      { codes: [accumDepreciationCode] },
      { creditPositive: true },
    );
    return row.cost_base_minor - net;
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

    const cls = asset.asset_class as AssetClass;
    const { fixedAssetCode, accumDepreciationCode } = CLASS_ACCOUNTS[cls];
    const depreciable = {
      acquisition_date: asset.acquisition_date,
      cost_base_minor: asset.cost_base_minor,
      useful_life_years: asset.useful_life_years,
      residual_value_minor: asset.residual_value_minor,
    };

    // (a) Catch-up depreciation up to the disposal date. v1 has no prior
    // depreciation posting (the annual close is a separate plan), so the
    // catch-up is the full accumulated depreciation as of the disposal date.
    const catchUp = depreciationCharge(depreciable, null, dto.disposal_date);
    const accumulated = accumulatedDepreciationAsOf(
      depreciable,
      dto.disposal_date,
    );

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
        await trx
          .updateTable('fixed_asset')
          .set({
            retired_at: Math.floor(Date.now() / 1000),
            disposal_voucher_id: disposalVoucher.id,
          })
          .where('id', '=', id)
          .execute();
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
      fx_rate: 1,
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
