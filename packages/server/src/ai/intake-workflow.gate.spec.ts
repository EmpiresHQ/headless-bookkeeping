import { ProcessingGate } from './processing-gate';
import { IntakeWorkflowService } from './intake-workflow.service';

describe('IntakeWorkflowService.process gating', () => {
  it('runs the workflow body inside the ProcessingGate', async () => {
    const gate = new ProcessingGate();
    const runSpy = jest.spyOn(gate, 'run');

    // getById is the very first thing processInner does; reject it to prove
    // the body executed (inside the gate) without standing up the whole pipeline.
    const documents = {
      getById: jest.fn().mockRejectedValue(new Error('sentinel')),
    };

    const service = new IntakeWorkflowService(
      {} as never, // ocrService
      {} as never, // pass2Agent
      {} as never, // proposeDraft
      {} as never, // auditFindings
      {} as never, // policyService
      documents as never, // documents
      {} as never, // entities
      {} as never, // organizationService
      {} as never, // bankIngestion
      gate,
      {} as never, // db
      {} as never, // auditLog
    );

    await expect(service.process(1)).rejects.toThrow('sentinel');
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(documents.getById).toHaveBeenCalledWith(1);
  });
});

describe('IntakeWorkflowService.debug gating', () => {
  it('routes debug() through the ProcessingGate', async () => {
    const gate = new ProcessingGate();
    const runSpy = jest.spyOn(gate, 'run');

    const sentinel = new Error('debug-sentinel');
    const ocrService = {
      transcribe: jest.fn().mockRejectedValue(sentinel),
    };

    const service = new IntakeWorkflowService(
      ocrService as never, // ocrService
      {} as never, // pass2Agent
      {} as never, // proposeDraft
      {} as never, // auditFindings
      {} as never, // policyService
      {} as never, // documents
      {} as never, // entities
      {} as never, // organizationService
      {} as never, // bankIngestion
      gate,
      {} as never, // db
      {} as never, // auditLog
    );

    await expect(service.debug(1)).rejects.toThrow('debug-sentinel');
    expect(runSpy).toHaveBeenCalledTimes(1);
  });
});
