// src/interaction/router/flow-dispatcher.ts
import { Injectable } from '@nestjs/common';
import { RoutedIntent } from './types';

export interface DispatchContext {
  conversation_id: number;
}

export interface DispatchResult {
  handled: boolean;
  /** Optional dialogue reply to send back on the channel. */
  reply?: string;
}

/** The seam 8b plugs real conversational flows into. */
export abstract class FlowDispatcher {
  abstract dispatch(
    intent: RoutedIntent,
    ctx: DispatchContext,
  ): Promise<DispatchResult>;
}

/** 8a stub: records calls, handles nothing. Replaced by real flows in 8b. */
@Injectable()
export class RecordingFlowDispatcher extends FlowDispatcher {
  readonly calls: { intent: RoutedIntent; ctx: DispatchContext }[] = [];

  dispatch(
    intent: RoutedIntent,
    ctx: DispatchContext,
  ): Promise<DispatchResult> {
    this.calls.push({ intent, ctx });
    return Promise.resolve({ handled: false });
  }
}

/** 8a production stub: handles nothing, records nothing. Replaced by real flows in 8b. */
@Injectable()
export class NoopFlowDispatcher extends FlowDispatcher {
  dispatch(): Promise<DispatchResult> {
    return Promise.resolve({ handled: false });
  }
}
