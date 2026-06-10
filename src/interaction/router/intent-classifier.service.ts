// src/interaction/router/intent-classifier.service.ts
import { Injectable } from '@nestjs/common';
import { Agent } from '@mastra/core/agent';
import { AgentConfigService } from '../../ai/agent-config.service';
import { routedIntentSchema, mapToRoutedIntent } from './routed-intent.schema';
import { RoutedIntent } from './types';

const CLARIFY_FALLBACK = 'Could you rephrase what you need?';

@Injectable()
export class IntentClassifierService {
  private agent: Agent | null = null;

  constructor(private readonly config: AgentConfigService) {}

  async initialize(): Promise<void> {
    const { instructions } = await this.config.resolve('intent_classifier');
    const model = await this.config.resolveModelConfig('intent_classifier');
    this.agent = new Agent({
      id: 'intent-classifier',
      name: 'Intent Classifier',
      instructions,
      model,
      tools: {},
    });
  }

  /** Test seam — lets a spec spy on agent.generate (mirrors Pass2AgentService). */
  agentForTest(): Agent {
    if (!this.agent) throw new Error('IntentClassifierService not initialized');
    return this.agent;
  }

  async classify(message: string): Promise<RoutedIntent> {
    if (!this.agent) throw new Error('IntentClassifierService not initialized');
    const result = await this.agent.generate(message, {
      structuredOutput: { schema: routedIntentSchema },
    });
    const parsed = routedIntentSchema.safeParse(result.object);
    if (!parsed.success) {
      return { kind: 'clarify', question: CLARIFY_FALLBACK };
    }
    return mapToRoutedIntent(parsed.data);
  }
}
