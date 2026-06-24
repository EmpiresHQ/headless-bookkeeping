import { Injectable } from '@nestjs/common';
import { FlowDispatcher, DispatchContext, DispatchResult } from './flow-dispatcher';
import { RoutedIntent } from './types';
import { AllowanceFlow } from './flows/allowance-flow';

@Injectable()
export class RealFlowDispatcher extends FlowDispatcher {
  constructor(private readonly allowanceFlow: AllowanceFlow) {
    super();
  }

  async dispatch(
    intent: RoutedIntent,
    ctx: DispatchContext,
  ): Promise<DispatchResult> {
    if (
      intent.kind === 'action' &&
      intent.actionIntent === 'create_allowance'
    ) {
      return this.allowanceFlow.dispatch(intent, ctx);
    }

    return { handled: false };
  }
}
