import { IntakeQueueWorker } from './intake-queue.worker';


type FakeDoc = { id: number; attempts: number; done: boolean };

function makeDeps(docs: FakeDoc[]) {
  let active = 0;
  let maxActive = 0;
  const processed: number[] = [];

  const documents = {
    claimNextPending: jest.fn(async (_stale: number, max: number) => {
      const next = docs.find((d) => !d.done && d.attempts < max);
      if (!next) return null;
      next.attempts += 1;
      return next.id;
    }),
  };

  const workflow = {
    process: jest.fn(async (id: number) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 3));
      active -= 1;
      const d = docs.find((x) => x.id === id)!;
      d.done = true; // success removes it from the pending set
      processed.push(id);
      return { status: 'needs_triage', reason: 'x' } as never;
    }),
  };

  return { documents, workflow, get maxActive() { return maxActive; }, processed };
}

describe('IntakeQueueWorker', () => {
  it('drains all pending documents, never two at once', async () => {
    const docs: FakeDoc[] = [1, 2, 3, 4, 5].map((id) => ({
      id,
      attempts: 0,
      done: false,
    }));
    const deps = makeDeps(docs);
    const worker = new IntakeQueueWorker(
      deps.documents as never,
      deps.workflow as never,
    );

    await worker.drainLoop();

    expect(deps.processed.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(deps.maxActive).toBe(1);
  });

  it('keeps draining after one document throws (failure isolation)', async () => {
    const docs: FakeDoc[] = [1, 2, 3].map((id) => ({
      id,
      attempts: 0,
      done: false,
    }));
    const deps = makeDeps(docs);
    deps.workflow.process.mockImplementationOnce(async () => {
      throw new Error('boom'); // document 1 throws, stays pending
    });
    const worker = new IntakeQueueWorker(
      deps.documents as never,
      deps.workflow as never,
    );

    await worker.drainLoop();

    // 2 and 3 still processed; the loop did not die on the throw.
    expect(deps.processed).toEqual(expect.arrayContaining([2, 3]));
  });

  it('stops re-claiming a document once it hits the attempt cap (poison guard)', async () => {
    const docs: FakeDoc[] = [{ id: 1, attempts: 0, done: false }];
    const deps = makeDeps(docs);
    deps.workflow.process.mockImplementation(async () => {
      throw new Error('always fails'); // never marks done
    });
    const worker = new IntakeQueueWorker(
      deps.documents as never,
      deps.workflow as never,
    );

    await worker.drainLoop();

    // claimNextPending excludes attempts >= MAX_ATTEMPTS, so the loop ends.
    expect(deps.workflow.process).toHaveBeenCalledTimes(3); // MAX_ATTEMPTS
  });

  it('kick() is single-flight (one drain loop at a time)', async () => {
    const docs: FakeDoc[] = [{ id: 1, attempts: 0, done: false }];
    const deps = makeDeps(docs);
    const worker = new IntakeQueueWorker(
      deps.documents as never,
      deps.workflow as never,
    );

    await Promise.all([worker.kick(), worker.kick(), worker.kick()]);
    expect(deps.processed).toEqual([1]); // processed exactly once
  });
});

describe('IntakeQueueWorker.onModuleInit under test', () => {
  it('does not arm setInterval when NODE_ENV=test', () => {
    // Jest sets NODE_ENV='test' by default — verify the early-return guard.
    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    const worker = new IntakeQueueWorker(
      {} as never,
      {} as never,
    );

    worker.onModuleInit();

    expect(setIntervalSpy).not.toHaveBeenCalled();

    // onModuleDestroy must be a safe no-op (timer is null).
    expect(() => worker.onModuleDestroy()).not.toThrow();

    setIntervalSpy.mockRestore();
  });
});
