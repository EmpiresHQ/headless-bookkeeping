// src/interaction/router/flow-dispatcher.spec.ts
import { RecordingFlowDispatcher } from './flow-dispatcher';
import { RoutedIntent } from './types';

describe('RecordingFlowDispatcher (8a stub)', () => {
  it('records the dispatched intent and reports unhandled', async () => {
    const d = new RecordingFlowDispatcher();
    const intent: RoutedIntent = {
      kind: 'action',
      actionIntent: 'create_sales_invoice',
      fields: {},
    };
    const result = await d.dispatch(intent, { conversation_id: 7 });
    expect(result.handled).toBe(false);
    expect(d.calls).toEqual([{ intent, ctx: { conversation_id: 7 } }]);
  });
});
