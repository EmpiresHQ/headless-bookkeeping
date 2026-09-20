import { Kysely } from 'kysely';
import { Database } from '../../src/database/types';

export interface SeedAllowanceInput {
  claimantId: number;
  type: string;
  /** days: for daily_allowance */
  taxFreeDays?: number;
  taxFreeAmount: number;
  taxableAmount: number;
  /** km: for mileage (optional, stored in km column) */
  km?: number;
  periodStart: string;
  periodEnd?: string;
  status?: string;
  tripId?: number;
  /**
   * Per-month breakdown JSON (the daily_allowance accumulation query reads
   * day counts from here via json_each, not the top-level `days` column).
   * Pass an array of segments; it is JSON-stringified into the breakdown column.
   */
  breakdown?: Array<Record<string, unknown>>;
  /** Health eligibility facts (issue #212); omitted = a legacy row with none. */
  health?: {
    category?: string;
    claimantRelation?: string;
    supportingDocumentRef?: string;
    providerRegistration?: string;
    offeredToAllEmployees?: boolean;
  };
  fringeIncomeTax?: number;
  fringeSocialTax?: number;
}

/**
 * Seed an allowance row directly into the DB for unit tests.
 * grossAmount = taxFreeAmount + taxableAmount.
 */
export async function seedAllowance(
  db: Kysely<Database>,
  input: SeedAllowanceInput,
): Promise<{ id: number }> {
  const now = Math.floor(Date.now() / 1000);
  const grossAmount = input.taxFreeAmount + input.taxableAmount;

  const row = await db
    .insertInto('allowance')
    .values({
      claimant_id: input.claimantId,
      trip_id: input.tripId ?? null,
      type: input.type,
      days: input.taxFreeDays ?? null,
      km: input.km ?? null,
      input_amount: null,
      route_description: null,
      gross_amount: grossAmount,
      tax_free_amount: input.taxFreeAmount,
      taxable_amount: input.taxableAmount,
      breakdown: input.breakdown ? JSON.stringify(input.breakdown) : null,
      health_category: input.health?.category ?? null,
      claimant_relation: input.health?.claimantRelation ?? null,
      supporting_document_ref: input.health?.supportingDocumentRef ?? null,
      provider_registration: input.health?.providerRegistration ?? null,
      offered_to_all_employees:
        input.health?.offeredToAllEmployees === undefined
          ? null
          : input.health.offeredToAllEmployees
            ? 1
            : 0,
      fringe_income_tax_amount: input.fringeIncomeTax ?? 0,
      fringe_social_tax_amount: input.fringeSocialTax ?? 0,
      period_start: input.periodStart,
      period_end: input.periodEnd ?? null,
      status: input.status ?? 'posted',
      voucher_id: null,
      created_at: now,
      updated_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return { id: row.id };
}
