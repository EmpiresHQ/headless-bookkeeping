import { ProcessingGate } from './processing-gate';

describe('ProcessingGate', () => {
  it('never runs two tasks concurrently', async () => {
    const gate = new ProcessingGate();
    let active = 0;
    let maxActive = 0;

    const task = () =>
      gate.run(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
      });

    await Promise.all([task(), task(), task(), task(), task()]);
    expect(maxActive).toBe(1);
  });

  it('runs tasks in submission order', async () => {
    const gate = new ProcessingGate();
    const order: number[] = [];
    const mk = (n: number) =>
      gate.run(async () => {
        await new Promise((r) => setTimeout(r, 1));
        order.push(n);
      });
    await Promise.all([mk(1), mk(2), mk(3)]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('keeps serializing after a task rejects', async () => {
    const gate = new ProcessingGate();
    const order: string[] = [];
    const failing = gate
      .run(async () => {
        order.push('a');
        throw new Error('boom');
      })
      .catch(() => order.push('a-caught'));
    const next = gate.run(async () => {
      order.push('b');
    });
    await Promise.all([failing, next]);
    expect(order).toEqual(['a', 'a-caught', 'b']);
  });

  it('returns the task result', async () => {
    const gate = new ProcessingGate();
    await expect(gate.run(async () => 42)).resolves.toBe(42);
  });
});
