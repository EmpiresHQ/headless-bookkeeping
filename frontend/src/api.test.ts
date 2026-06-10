import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setToken } from './auth';
import { deleteExpense, getKmd } from './api';

describe('api delete + kmd', () => {
  beforeEach(() => {
    localStorage.clear();
    setToken('tok');
  });
  afterEach(() => vi.restoreAllMocks());

  it('deleteExpense issues a DELETE to the expense path', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"id":7}', { status: 200 }));
    await deleteExpense(7);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/expenses/7');
    expect(init?.method).toBe('DELETE');
  });

  it('getKmd fetches the period KMD declaration', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('{"reporting_period_id":3,"review_flags":[]}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const d = await getKmd(3);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/reporting-periods/3/kmd');
    expect(d.reporting_period_id).toBe(3);
  });
});
