// src/interaction/router/intent-classifier.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { Agent } from '@mastra/core/agent'; // resolves to test/mastra-stub.ts
import { IntentClassifierService } from './intent-classifier.service';

describe('IntentClassifierService', () => {
  let service: IntentClassifierService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [IntentClassifierService],
    }).compile();
    service = module.get(IntentClassifierService);
    await service.initialize();
  });

  it('returns the agent-classified action intent', async () => {
    const agent: Agent = service.agentForTest();
    jest.spyOn(agent, 'generate').mockResolvedValue({
      object: {
        kind: 'action',
        actionIntent: 'create_sales_invoice',
        fields: { amount: '10000' },
      },
      text: '',
    });

    const intent = await service.classify('please invoice Acme 100 eur');
    expect(intent).toEqual({
      kind: 'action',
      actionIntent: 'create_sales_invoice',
      fields: { amount: '10000' },
    });
  });

  it('degrades an unparseable agent output to a clarify (never throws)', async () => {
    const agent: Agent = service.agentForTest();
    jest
      .spyOn(agent, 'generate')
      .mockResolvedValue({ object: { kind: 'banana' }, text: '' });

    const intent = await service.classify('???');
    expect(intent.kind).toBe('clarify');
  });
});
