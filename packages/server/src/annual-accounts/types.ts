import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Finalize an annual-accounts year. The body carries an explicit confirmation
 * so a finalize is never a stray click — finalizing posts depreciation and
 * locks the year (one-shot, ADR-0034 §5).
 */
export const finalizeAnnualAccountsSchema = z.object({
  confirm: z.literal(true),
});

export class FinalizeAnnualAccountsDto extends createZodDto(
  finalizeAnnualAccountsSchema,
) {}
