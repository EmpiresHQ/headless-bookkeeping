// src/interaction/router/flow-dispatcher.spec.ts
import { RecordingFlowDispatcher, NoopFlowDispatcher } from './flow-dispatcher';
import { RoutedIntent } from './types';
import { Principal } from '../principal/types';

describe('RecordingFlowDispatcher (8a stub)', () => {
  it('records the dispatched intent (with principal) and reports unhandled', async () => {
    const d = new RecordingFlowDispatcher();
    const intent: RoutedIntent = {
      kind: 'action',
      actionIntent: 'create_sales_invoice',
      fields: {},
    };
    const principal: Principal = {
      role: 'approver',
      authVerified: true,
      senderId: '999',
    };
    const result = await d.dispatch(intent, { conversation_id: 7, principal });
    expect(result.handled).toBe(false);
    expect(d.calls).toEqual([
      { intent, ctx: { conversation_id: 7, principal } },
    ]);
  });
});

describe('NoopFlowDispatcher (8a production stub)', () => {
  it('returns {handled:false} and exposes no calls array', async () => {
    const d = new NoopFlowDispatcher();
    const intent: RoutedIntent = {
      kind: 'action',
      actionIntent: 'create_sales_invoice',
      fields: {},
    };
    const result = await d.dispatch(intent, {
      conversation_id: 42,
      principal: { role: 'approver', authVerified: true, senderId: '999' },
    });
    expect(result.handled).toBe(false);
    expect((d as unknown as { calls?: unknown }).calls).toBeUndefined();
  });
});
