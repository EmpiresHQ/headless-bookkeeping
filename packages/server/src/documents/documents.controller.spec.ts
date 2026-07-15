import { DocumentsController } from './documents.controller';
import type { DocumentsService } from './documents.service';
import type { DocumentUrlSignerService } from './document-url-signer.service';

/**
 * Focused unit coverage for the Retry AI path: the controller relays the
 * `requeued` signal from reprocessDocument so a real re-queue is
 * distinguishable from an idempotent no-op (the worker kick itself is fired by
 * the service — see documents.service.spec / intake-queue.worker.spec).
 */
describe('DocumentsController.retryDocument', () => {
  function makeController(reprocessResult: {
    requeued: boolean;
    priorStatus: string | null;
  }) {
    const reprocessDocument = jest.fn().mockResolvedValue(reprocessResult);

    const controller = new DocumentsController(
      { reprocessDocument } as unknown as DocumentsService,
      {} as unknown as DocumentUrlSignerService,
    );

    return { controller, reprocessDocument };
  }

  it('reports requeued=true after a successful reprocess', async () => {
    const { controller, reprocessDocument } = makeController({
      requeued: true,
      priorStatus: 'needs_triage',
    });

    const res = await controller.retryDocument('42');

    expect(reprocessDocument).toHaveBeenCalledWith(42);
    expect(res).toEqual({ ok: true, requeued: true });
  });

  it('reports requeued=false when reprocess is a no-op (does not silently succeed)', async () => {
    const { controller } = makeController({
      requeued: false,
      priorStatus: 'processed',
    });

    const res = await controller.retryDocument('42');

    expect(res).toEqual({ ok: true, requeued: false });
  });
});
