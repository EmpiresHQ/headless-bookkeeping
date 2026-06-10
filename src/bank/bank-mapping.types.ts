import { z } from 'zod';

/**
 * The LLM's output: how to read ONE bank's CSV. A column reference is a header
 * name; transforms are a small fixed vocabulary the deterministic transformer
 * understands. Kept deliberately narrow so a malformed mapping fails Zod rather
 * than smuggling arbitrary behavior into the kernel.
 */
export const mappingRulesetSchema = z.object({
  account_code: z.string(),
  date_column: z.string(),
  date_format: z.string(),
  amount: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('signed'), column: z.string() }),
    z.object({
      mode: z.literal('debit_credit'),
      amount_column: z.string(),
      indicator_column: z.string(),
      debit_value: z.string(),
    }),
  ]),
  currency_column: z.string().nullable(),
  default_currency: z.string(),
  description_column: z.string().nullable(),
  counterparty_iban_column: z.string().nullable(),
  counterparty_descriptor_column: z.string().nullable(),
  reference_column: z.string().nullable(),
});

export type MappingRuleset = z.infer<typeof mappingRulesetSchema>;
