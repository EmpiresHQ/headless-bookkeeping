import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setToken } from './auth';
import {
  getPeriodWarnings,
  getSubmissionState,
  lockPeriod,
  recordSubmissionEvent,
  setExpenseDocumentMetadata,
} from './api';

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

describe('reports api additions', () => {
  beforeEach(() => {
    localStorage.clear();
    setToken('tok');
  });
  afterEach(() => vi.restoreAllMocks());

  it('lockPeriod POSTs the lock endpoint and returns the locked period', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      ok({
        id: 7,
        name: '2026-06',
        start_date: '2026-06-01',
        end_date: '2026-06-30',
        status: 'locked',
        filed_at: 1751600000,
      }),
    );
    const p = await lockPeriod(7);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/reporting-periods/7/lock');
    expect(init?.method).toBe('POST');
    expect(p.status).toBe('locked');
    expect(p.filed_at).toBe(1751600000);
  });

  it('getPeriodWarnings unwraps the warnings array', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      ok({
        warnings: [
          {
            type: 'pending_approval',
            object_type: 'expense',
            object_id: 12,
            description: 'Expense #12 (rent, EUR 65000) awaiting approval',
          },
        ],
      }),
    );
    const rows = await getPeriodWarnings(7);
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/reporting-periods/7/warnings',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].object_type).toBe('expense');
    expect(rows[0].object_id).toBe(12);
  });

  it('getSubmissionState GETs the folded state with history', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      ok({
        status: 'accepted',
        currentSnapshotId: 3,
        lastExternalRef: 'KMD-2026-06-001',
        submissionCount: 1,
        history: [
          {
            id: 1,
            reporting_period_id: 7,
            report_kind: 'EE_KMD',
            source_snapshot_type: 'vat_report',
            source_snapshot_id: 3,
            event_kind: 'prepared',
            external_ref: null,
            occurred_at: 1751600000,
            actor: 'system',
            note: null,
          },
        ],
      }),
    );
    const state = await getSubmissionState(7);
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/reporting-periods/7/submission-state',
    );
    expect(state.status).toBe('accepted');
    expect(state.lastExternalRef).toBe('KMD-2026-06-001');
    expect(state.history[0].event_kind).toBe('prepared');
    expect(state.history[0].actor).toBe('system');
  });

  it('recordSubmissionEvent POSTs the operator event body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      ok({
        id: 2,
        reporting_period_id: 7,
        report_kind: 'EE_KMD',
        source_snapshot_type: 'vat_report',
        source_snapshot_id: 3,
        event_kind: 'submitted',
        external_ref: 'KMD-2026-06-001',
        occurred_at: 1751610000,
        actor: 'operator',
        note: null,
      }),
    );
    const ev = await recordSubmissionEvent(7, {
      event_kind: 'submitted',
      external_ref: 'KMD-2026-06-001',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/reporting-periods/7/submission-events');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      event_kind: 'submitted',
      external_ref: 'KMD-2026-06-001',
    });
    expect(ev.actor).toBe('operator');
  });

  it('setExpenseDocumentMetadata PATCHes the invoice number', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(ok({ id: 12, supplier_invoice_number: 'A-183' }));
    const res = await setExpenseDocumentMetadata(12, {
      supplier_invoice_number: 'A-183',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/expenses/12/document-metadata');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(init?.body as string)).toEqual({
      supplier_invoice_number: 'A-183',
    });
    expect(res.supplier_invoice_number).toBe('A-183');
  });
});
