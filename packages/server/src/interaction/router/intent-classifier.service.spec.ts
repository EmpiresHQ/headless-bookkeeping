// src/interaction/router/intent-classifier.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { Agent } from '@mastra/core/agent'; // resolves to test/mastra-stub.ts
import { IntentClassifierService } from './intent-classifier.service';
import { AgentConfigService } from '../../ai/agent-config.service';
import { AGENT_PROMPTS, DEFAULT_MODEL } from '../../ai/agent-config';

class FakeAgentConfig {
  resolve(): Promise<{ model: string; instructions: string }> {
    return Promise.resolve({
      model: DEFAULT_MODEL,
      instructions: AGENT_PROMPTS.intent_classifier,
    });
  }

  resolveModelConfig(): Promise<string> {
    return Promise.resolve(DEFAULT_MODEL);
  }
}

describe('IntentClassifierService', () => {
  let service: IntentClassifierService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: AgentConfigService, useClass: FakeAgentConfig },
        IntentClassifierService,
      ],
    }).compile();
    service = module.get(IntentClassifierService);
  });

  /**
   * Build the (stub) agent and pin buildAgent() to return it, so classify()'s
   * on-demand build resolves to this instance and the generate() spy applies.
   */
  const pinAgent = async (): Promise<Agent> => {
    const agent = await service.buildAgent();
    jest.spyOn(service, 'buildAgent').mockResolvedValue(agent);
    return agent;
  };

  it('returns the agent-classified action intent', async () => {
    const agent: Agent = await pinAgent();
    jest.spyOn(agent, 'generate').mockResolvedValue({
      object: {
        kind: 'action',
        actionIntent: 'create_sales_invoice',
        fields: { amount: '10000' },
      },
      text: '',
    } as any);

    const intent = await service.classify('please invoice Acme 100 eur');
    expect(intent).toEqual({
      kind: 'action',
      actionIntent: 'create_sales_invoice',
      fields: { amount: '10000' },
    });
  });

  it('degrades an unparseable agent output to a clarify (never throws)', async () => {
    const agent: Agent = await pinAgent();
    jest
      .spyOn(agent, 'generate')
      .mockResolvedValue({ object: { kind: 'banana' }, text: '' } as any);

    const intent = await service.classify('???');
    expect(intent.kind).toBe('clarify');
  });
});
