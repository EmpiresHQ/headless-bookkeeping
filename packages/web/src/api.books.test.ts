import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setToken } from './auth';
import {
  attachExpenseDocument,
  correctExpense,
  listAttachableDocuments,
  getCreditNote,
  listApprovals,
  postInvoice,
  uploadDocument,
} from './api';

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

describe('books api additions', () => {
  beforeEach(() => {
    localStorage.clear();
    setToken('tok');
  });
  afterEach(() => vi.restoreAllMocks());

  it('getCreditNote GETs the single credit note', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      ok({
        id: 7,
        credit_note_number: 'CN-1',
        status: 'posted',
        gross_amount: 12000,
        vat_amount: 2164,
        currency: 'EUR',
        tax_point_date: '2026-07-02',
        created_at: 1751400000,
        credits_object_type: 'sales_invoice',
        credits_object_id: 3,
        kind: 'sales',
        voucher_id: 99,
      }),
    );
    const cn = await getCreditNote(7);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/credit-notes/7');
    expect(cn.tax_point_date).toBe('2026-07-02');
    expect(cn.currency).toBe('EUR');
  });

  it('correctExpense returns the typed correction outcome incl. redirect', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      ok({
        outcome: 'posted_reversal_and_correction',
        reversalVoucherId: 1,
        correctedVoucherId: 2,
        redirected: true,
        redirectedToPeriodId: 5,
      }),
    );
    const res = await correctExpense(9, {
      kind: 'financial',
      reason: 'OCR misread the total',
      patch: { gross_amount: 65000, vat_amount: 11721 },
    });
    expect(res.outcome).toBe('posted_reversal_and_correction');
    expect(res.redirected).toBe(true);
  });

  it('listApprovals builds the query string and unwraps approvals', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      ok({
        approvals: [
          {
            id: 4,
            object_type: 'expense',
            object_id: 12,
            status: 'rejected',
            requested_by: 'system',
            approved_by: null,
            rejected_reason: 'Wrong supplier',
            policy_reason: null,
            superseded_by: null,
            created_at: 1751000000,
            resolved_at: 1751100000,
          },
        ],
      }),
    );
    const rows = await listApprovals({
      status: 'rejected',
      object_type: 'expense',
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/approvals?status=rejected&object_type=expense',
    );
    expect(rows[0].rejected_reason).toBe('Wrong supplier');
  });

  it('postInvoice POSTs the pipeline endpoint and types invoice + policy', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      ok({
        invoice: { id: 3, status: 'pending' },
        voucher: null,
        policy: { action: 'hold-for-approval', reason: 'ceiling' },
      }),
    );
    const res = await postInvoice(3);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/sales-invoices/3/post');
    expect(init?.method).toBe('POST');
    expect(res.policy.action).toBe('hold-for-approval');
  });

  it('uploadDocument appends claimant_id when provided and omits it otherwise', async () => {
    // mockImplementation (not mockResolvedValue) so each fetch() call gets a
    // fresh Response — uploadDocument is called twice below, and apiFetch
    // reads the body via res.json() each time; a shared Response instance
    // would throw "Body is unusable" on the second read.
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(ok({ document: { id: 1 }, deduplicated: false })),
      );
    const file = new File(['x'], 'r.pdf', { type: 'application/pdf' });
    await uploadDocument(file, { claimantId: 42 });
    const body1 = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(body1.get('claimant_id')).toBe('42');
    await uploadDocument(file);
    const body2 = fetchMock.mock.calls[1][1]?.body as FormData;
    expect(body2.get('claimant_id')).toBeNull();
  });

  it('attachExpenseDocument sends a multipart file OR a JSON document_id — never both', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        ok({ outcome: 'attached', expense: {}, document: {} }),
      );
    const file = new File(['x'], 'r.pdf', { type: 'application/pdf' });

    await attachExpenseDocument(12, { file });
    const [url1, init1] = fetchMock.mock.calls[0];
    expect(url1).toBe('/api/expenses/12/attach-document');
    expect(init1?.method).toBe('POST');
    const form = init1?.body as FormData;
    expect([...form.keys()]).toEqual(['file']);
    expect(new Headers(init1?.headers).get('content-type')).toBeNull();

    await attachExpenseDocument(12, { documentId: 44 });
    const [, init2] = fetchMock.mock.calls[1];
    expect(init2?.body).toBe('{"document_id":44}');
    expect(new Headers(init2?.headers).get('content-type')).toBe(
      'application/json',
    );
  });

  it('listAttachableDocuments unwraps the server-owned candidate list', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(ok({ documents: [{ id: 44 }] }));
    expect(await listAttachableDocuments(12)).toEqual([{ id: 44 }]);
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/expenses/12/attachable-documents',
    );
  });
});
