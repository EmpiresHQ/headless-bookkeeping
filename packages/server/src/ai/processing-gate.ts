import { Injectable } from '@nestjs/common';

/**
 * ProcessingGate — a single-process serializer (concurrency = 1).
 *
 * Submitted functions run strictly one at a time, in submission order. The
 * intake pipeline routes every `process()` through this gate so a burst of
 * uploads cannot fire concurrent OCR/LLM calls at the single vision endpoint
 * (one Node process => one in-memory mutex is enough; multi-instance is out of
 * scope by design).
 */
@Injectable()
export class ProcessingGate {
  // The tail of the run-chain. Always resolves (never rejects) so one failing
  // task cannot wedge the chain for the next caller.
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
