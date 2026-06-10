// src/interaction/router/intent-classifier.service.ts
import { Injectable } from '@nestjs/common';
import { Agent } from '@mastra/core/agent';
import { AgentConfigService } from '../../ai/agent-config.service';
import { routedIntentSchema, mapToRoutedIntent } from './routed-intent.schema';
import { RoutedIntent } from './types';

const CLARIFY_FALLBACK = 'Could you rephrase what you need?';

@Injectable()
export class IntentClassifierService {
  constructor(private readonly config: AgentConfigService) {}

  /**
   * Build the intent-classifier agent fresh from current settings, so operator
   * changes to the model / prompt / inference endpoint apply on the next
   * message without a restart. Also the test seam: specs spy on this to return
   * an agent whose `generate` is mocked.
   */
  async buildAgent(): Promise<Agent> {
    const { instructions } = await this.config.resolve('intent_classifier');
    const model = await this.config.resolveModelConfig('intent_classifier');
    return new Agent({
      id: 'intent-classifier',
      name: 'Intent Classifier',
      instructions,
      model,
      tools: {},
    });
  }

  async classify(message: string): Promise<RoutedIntent> {
    const agent = await this.buildAgent();
    const result = await agent.generate(message, {
      structuredOutput: { schema: routedIntentSchema },
    });
    const parsed = routedIntentSchema.safeParse(result.object);
    if (!parsed.success) {
      return { kind: 'clarify', question: CLARIFY_FALLBACK };
    }
    return mapToRoutedIntent(parsed.data);
  }
}
