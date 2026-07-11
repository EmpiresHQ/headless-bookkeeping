import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setToken } from './auth';
import { getExpense } from './api';

describe('inbox api additions', () => {
  beforeEach(() => {
    localStorage.clear();
    setToken('tok');
  });
  afterEach(() => vi.restoreAllMocks());

  it('getExpense GETs the single-expense endpoint and returns the detail subset', async () => {
    const body = JSON.stringify({
      id: 214,
      document_id: 88,
      supplier_id: 3,
      category: 'software',
      gross_amount: 8900,
      vat_amount: 1632,
      currency: 'EUR',
      tax_point_date: '2026-07-03',
      status: 'pending',
      supplier_invoice_number: 'A-183',
      ai_confidence: 0.94,
      voucher_id: null,
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(body, { status: 200 }));
    const res = await getExpense(214);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/expenses/214');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(res.document_id).toBe(88);
    expect(res.ai_confidence).toBe(0.94);
    expect(res.gross_amount).toBe(8900);
  });
});
