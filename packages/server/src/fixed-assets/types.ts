import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** A register row as returned by the read API. */
export interface FixedAsset {
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
}

/**
 * Register row + computed book value.
 *
 * `book_value_minor` is the asset's OWN cost less its OWN posted depreciation
 * (issue #214), and 0 once it is retired. `unattributed_depreciation_minor` is
 * depreciation posted on this asset's class that is not attributed to any
 * individual asset (a legacy close, a hand-posted charge): it is reported
 * beside the book value instead of being guessed at or silently ignored, and
 * while it is non-zero the same asset's disposal is refused until an
 * allocation is supplied (issue #208).
 */
export interface FixedAssetWithBookValue extends FixedAsset {
  book_value_minor: number;
  unattributed_depreciation_minor: number;
}

/**
 * An operator-supplied split of ONE posted voucher's accumulated-depreciation
 * movement across the assets it charged — the supported way to resolve a
 * legacy or hand-posted charge the kernel cannot attribute by itself. Validated
 * against the voucher's signed class legs (exact reconciliation, no
 * over-allocation) before anything is written.
 */
export const depreciationAllocationSchema = z.object({
  voucher_id: z.number().int().positive(),
  allocations: z
    .array(
      z.object({
        fixed_asset_id: z.number().int().positive(),
        amount_minor: z.number().int(),
      }),
    )
    .min(1),
});

export class DepreciationAllocationDto extends createZodDto(
  depreciationAllocationSchema,
) {}

/** Disposal request: a date and optional sale proceeds (minor units). */
export const disposeAssetSchema = z.object({
  disposal_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  proceeds_minor: z.number().int().nonnegative().optional(),
});

export class DisposeAssetDto extends createZodDto(disposeAssetSchema) {}
