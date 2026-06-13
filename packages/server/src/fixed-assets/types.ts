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

/** Register row + computed book value (cost − Σ depreciation vouchers). */
export interface FixedAssetWithBookValue extends FixedAsset {
  book_value_minor: number;
}

/** Disposal request: a date and optional sale proceeds (minor units). */
export const disposeAssetSchema = z.object({
  disposal_date: z.string(),
  proceeds_minor: z.number().int().nonnegative().optional(),
});

export class DisposeAssetDto extends createZodDto(disposeAssetSchema) {}
