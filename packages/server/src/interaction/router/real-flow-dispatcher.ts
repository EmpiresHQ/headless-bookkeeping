import { Injectable } from '@nestjs/common';
import {
  FlowDispatcher,
  DispatchContext,
  DispatchResult,
} from './flow-dispatcher';
import { RoutedIntent } from './types';
import { AllowanceFlow } from './flows/allowance-flow';
import { ApprovalFlow } from './flows/approval-flow';

@Injectable()
export class RealFlowDispatcher extends FlowDispatcher {
  constructor(
    private readonly allowanceFlow: AllowanceFlow,
    private readonly approvalFlow: ApprovalFlow,
  ) {
    super();
  }

  async dispatch(
    intent: RoutedIntent,
    ctx: DispatchContext,
  ): Promise<DispatchResult> {
    if (intent.kind !== 'action') {
      return { handled: false };
    }

    switch (intent.actionIntent) {
      case 'create_allowance':
        return this.allowanceFlow.dispatch(intent, ctx);
      case 'approve':
      case 'reject':
        return this.approvalFlow.dispatch(intent, ctx);
      default:
        return { handled: false };
    }
  }
}
