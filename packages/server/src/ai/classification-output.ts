import { triageResultSchema } from '../triage/types';

/**
 * The model's transport shape permits "not applicable" nulls. Mastra validates
 * it before returning control to Pass2, so normalization only after generate()
 * cannot repair a null rejected by the SDK itself.
 *
 * This is NOT the booking contract: every result still passes the unchanged
 * strict triageResultSchema below before entering the application.
 */
export const classificationOutputSchema = triageResultSchema.extend({
  tax_point_date: triageResultSchema.shape.tax_point_date.nullable(),
  supplier_proposal: triageResultSchema.shape.supplier_proposal.nullable(),
  customer_proposal: triageResultSchema.shape.customer_proposal.nullable(),
});

export function parseClassificationOutput(input: unknown) {
  if (
    typeof input === 'object' &&
    input !== null &&
    'kind' in input &&
    input.kind === 'not_a_document'
  ) {
    // Only an explicit non-booking decision has inapplicable accounting fields.
    // Missing/invalid dates and counterparties on purchases/sales stay errors.
    const normalized = { ...input } as Record<string, unknown>;
    if (normalized.tax_point_date === null) normalized.tax_point_date = '';
    if (normalized.supplier_proposal === null)
      delete normalized.supplier_proposal;
    if (normalized.customer_proposal === null)
      delete normalized.customer_proposal;
    return triageResultSchema.safeParse(normalized);
  }
  return triageResultSchema.safeParse(input);
}
