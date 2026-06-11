import { routedIntentSchema, mapToRoutedIntent } from './routed-intent.schema';

describe('routedIntentSchema + mapToRoutedIntent', () => {
  it('maps an advisory classification', () => {
    const raw = routedIntentSchema.parse({ kind: 'advisory' });
    expect(mapToRoutedIntent(raw)).toEqual({ kind: 'advisory' });
  });

  it('maps an action classification with intent + fields', () => {
    const raw = routedIntentSchema.parse({
      kind: 'action',
      actionIntent: 'create_sales_invoice',
      fields: { amount: '10000', currency: 'EUR' },
    });
    expect(mapToRoutedIntent(raw)).toEqual({
      kind: 'action',
      actionIntent: 'create_sales_invoice',
      fields: { amount: '10000', currency: 'EUR' },
    });
  });

  it('maps a clarify classification', () => {
    const raw = routedIntentSchema.parse({
      kind: 'clarify',
      question: 'Which customer?',
    });
    expect(mapToRoutedIntent(raw)).toEqual({
      kind: 'clarify',
      question: 'Which customer?',
    });
  });

  it('defaults a malformed action (missing actionIntent) to a clarify', () => {
    const raw = routedIntentSchema.parse({ kind: 'action' });
    expect(mapToRoutedIntent(raw)).toEqual({
      kind: 'clarify',
      question: expect.any(String) as string,
    });
  });
});
