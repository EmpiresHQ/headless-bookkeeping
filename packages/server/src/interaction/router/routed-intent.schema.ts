import { z } from 'zod';
import { RoutedIntent } from './types';

export const routedIntentSchema = z.object({
  kind: z.enum(['advisory', 'action', 'report', 'reconciliation', 'clarify']),
  actionIntent: z
    .enum(['create_sales_invoice', 'approve', 'reject', 'correct', 'create_allowance'])
    .optional(),
  fields: z.record(z.string(), z.string()).optional(),
  reportKind: z.string().optional(),
  question: z.string().optional(),
});

export type RawRoutedIntent = z.infer<typeof routedIntentSchema>;

const CLARIFY_FALLBACK =
  'Sorry, I did not quite get that — could you rephrase what you need?';

export function mapToRoutedIntent(raw: RawRoutedIntent): RoutedIntent {
  switch (raw.kind) {
    case 'advisory':
      return { kind: 'advisory' };
    case 'reconciliation':
      return { kind: 'reconciliation' };
    case 'report':
      return { kind: 'report', reportKind: raw.reportKind ?? 'unspecified' };
    case 'clarify':
      return { kind: 'clarify', question: raw.question ?? CLARIFY_FALLBACK };
    case 'action':
      if (!raw.actionIntent) {
        return { kind: 'clarify', question: CLARIFY_FALLBACK };
      }
      return {
        kind: 'action',
        actionIntent: raw.actionIntent,
        fields: raw.fields ?? {},
      };
  }
}
