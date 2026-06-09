// src/interaction/router/intent-classifier.service.ts
import { Injectable } from '@nestjs/common';
import { Agent } from '@mastra/core/agent';
import { routedIntentSchema, mapToRoutedIntent } from './routed-intent.schema';
import { RoutedIntent } from './types';

const INSTRUCTIONS = `You classify a single user message in an accounting assistant into one intent.
- advisory: a read-only question about the books.
- action: the user wants to do something. Set actionIntent (create_sales_invoice | approve | reject | correct) and pull any obvious fields.
- report: the user wants a report; set reportKind.
- reconciliation: the user is resolving a bank line.
- clarify: you are NOT confident. Set a short question. Prefer clarify over guessing.`;

const CLARIFY_FALLBACK = 'Could you rephrase what you need?';

@Injectable()
export class IntentClassifierService {
  private agent: Agent | null = null;

  initialize(): Promise<void> {
    this.agent = new Agent({
      id: 'intent-classifier',
      name: 'Intent Classifier',
      instructions: INSTRUCTIONS,
      model: 'openai/gpt-4o-mini',
      tools: {},
    });
    return Promise.resolve();
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
