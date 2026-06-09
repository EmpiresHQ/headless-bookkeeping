/**
 * DTOs for the dividend distribution flow.
 *
 * Per ADR-0023:
 * - Declaration: equity distribution Dr RETAINED_EARNINGS / Cr DIVIDEND_PAYABLE
 *   (split with withholding when plugin rate > 0).
 * - Settlement: bank outflow draws down DIVIDEND_PAYABLE via N:M reconciliation_match.
 */

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Input for declaring a dividend distribution. */
export const dividendDeclarationSchema = z.object({
  /** Gross dividend amount in base-currency cents (positive). */
  gross_amount: z.number().int(),
  /** Tax-point date (YYYY-MM-DD) — determines the reporting period. */
  tax_point_date: z.string(),
  /** Optional reason / memo for the declaration. */
  reason: z.string().optional(),
});

export class DividendDeclarationDto extends createZodDto(
  dividendDeclarationSchema,
) {}

/** Input for settling a dividend against a bank transaction. */
export const dividendSettlementSchema = z.object({
  declaration_voucher_id: z.number().int(),
});

export class DividendSettlementDto extends createZodDto(
  dividendSettlementSchema,
) {}

/** Result of a successful dividend declaration. */
export interface DividendDeclarationResult {
  /** The posted declaration voucher ID. */
  voucher_id: number;
  /** Gross dividend in base-currency cents. */
  gross_amount: number;
  /** Net payable to owner (after withholding) in base-currency cents. */
  net_payable: number;
  /** Withholding tax amount in base-currency cents (0 if no withholding). */
  withholding_amount: number;
}

/** Result of a successful dividend settlement. */
export interface DividendSettlementResult {
  /** The posted settlement voucher ID. */
  voucher_id: number;
  /** The reconciliation match ID linking bank txn to declaration voucher. */
  reconciliation_match_id: number;
  /** Amount settled in base-currency cents. */
  amount_settled: number;
}
