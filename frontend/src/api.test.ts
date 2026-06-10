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

  it('uploadDocument POSTs multipart FormData (no JSON content-type)', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('{"document":{"id":5},"deduplicated":false}', {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const { uploadDocument } = await import('./api');
    const file = new File(['x'], 'invoice.pdf', { type: 'application/pdf' });
    await uploadDocument(file);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/documents');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
    const headers = new Headers(init?.headers);
    expect(headers.get('content-type')).toBeNull();
  });

  it('triageDocument POSTs to the triage path', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('{"kind":"unknown","document_id":5,"reason":"x"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const { triageDocument } = await import('./api');
    await triageDocument(5);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/documents/5/triage');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
  });

  it('approveApproval POSTs approved_by as JSON', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('{"approval":{"id":9},"voucher":null}', {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const { approveApproval } = await import('./api');
    await approveApproval(9, 'operator');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/approvals/9/approve');
    expect(JSON.parse(init?.body as string)).toEqual({ approved_by: 'operator' });
  });
});
