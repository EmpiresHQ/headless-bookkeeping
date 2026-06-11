import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setToken } from './auth';
import { deleteExpense, getKmd, downloadStatutoryReport, resolveSupplier } from './api';

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

  it('setSetting PUTs the value as JSON to the key path', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('{"key":"ai_model","value":"openai/gpt-4o"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const { setSetting } = await import('./api');
    await setSetting('ai_model', 'openai/gpt-4o');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/admin/settings/ai_model');
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(init?.body as string)).toEqual({ value: 'openai/gpt-4o' });
  });

  it('importBankStatement POSTs multipart FormData (no JSON content-type)', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('{"jobId":3}', {
          status: 202,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const { importBankStatement } = await import('./api');
    const file = new File(['Date,Amount\n'], 's.csv', { type: 'text/csv' });
    await importBankStatement(file, 'BANK_EUR');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/bank-statements/import');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
    const headers = new Headers(init?.headers);
    expect(headers.get('content-type')).toBeNull();
  });

  it('getPolicyConfig GETs /api/policy-config', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"auto_post_amount_ceiling":50000}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const { getPolicyConfig } = await import('./api');
    const cfg = await getPolicyConfig();
    expect(cfg.auto_post_amount_ceiling).toBe(50000);
  });

  it('updatePolicyConfig PUTs a partial patch as JSON', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('{"auto_post_amount_ceiling":10000}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const { updatePolicyConfig } = await import('./api');
    await updatePolicyConfig({ auto_post_amount_ceiling: 10000 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/policy-config');
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(init?.body as string)).toEqual({
      auto_post_amount_ceiling: 10000,
    });
  });

  it('resolveSupplier POSTs the chosen entity id', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('{"kind":"expense","document_id":4,"expense_id":55}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const out = await resolveSupplier(4, 3);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/documents/4/resolve-supplier');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ supplier_entity_id: 3 });
    expect(out).toEqual({ kind: 'expense', document_id: 4, expense_id: 55 });
  });

  it('downloadStatutoryReport requests the period endpoint with the format', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Blob(['<vatDeclaration/>']), {
        status: 200,
        headers: {
          'content-type': 'application/xml',
          'content-disposition': 'attachment; filename="kmd-2026-05.xml"',
        },
      }),
    );
    // stub DOM bits that jsdom doesn't support
    URL.createObjectURL = vi.fn().mockReturnValue('blob:stub');
    URL.revokeObjectURL = vi.fn();
    const createObjUrl = URL.createObjectURL as ReturnType<typeof vi.fn>;
    const revokeObjUrl = URL.revokeObjectURL as ReturnType<typeof vi.fn>;
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockReturnValue(undefined);

    await downloadStatutoryReport(5, 'xml');

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/reporting-periods/5/statutory-report?format=xml'),
      expect.any(Object),
    );
    expect(createObjUrl).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(revokeObjUrl).toHaveBeenCalledWith('blob:stub');
  });
});
