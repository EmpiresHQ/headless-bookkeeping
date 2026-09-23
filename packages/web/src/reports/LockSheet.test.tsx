import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppToaster } from '../ui/toast';
import { LockSheet } from './LockSheet';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  lockPeriod: vi.fn(),
  getPeriodWarnings: vi.fn(),
  getExpenses: vi.fn(),
  getInvoices: vi.fn(),
  getEntities: vi.fn(),
  getKmd: vi.fn(),
}));
import {
  getEntities,
  getKmd,
  getExpenses,
  getInvoices,
  getPeriodWarnings,
  lockPeriod,
} from '../api';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';
import { sharedKeys } from '../queries/keys';
import { reportsKeys } from '../queries/reports';

const PERIOD = {
  id: 6,
  name: '2026-06',
  start_date: '2026-06-01',
  end_date: '2026-06-30',
  status: 'open' as const,
  filed_at: null,
};

const KMD = {
  reporting_period_id: 6,
  period_name: '2026-06',
  start_date: '2026-06-01',
  end_date: '2026-06-30',
  row1_base_24: 0,
  row2_base_reduced: 0,
  row3_base_zero: 0,
  row4_output_vat: 0,
  row5_input_vat: 0,
  row6_intra_eu_acquisition: 0,
  row7_other_acquisition: 0,
  net_vat_due: 62407,
  vd_intra_eu_services: 0,
  review_flags: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

function mountSheet(
  warnings: unknown[] = [],
  seed?: (qc: QueryClient) => void,
  keepMocks = false,
) {
  if (!keepMocks) {
    vi.mocked(getPeriodWarnings).mockResolvedValue(warnings as never);
    vi.mocked(getKmd).mockResolvedValue(KMD as never);
  }
  if (!keepMocks)
    vi.mocked(getExpenses).mockResolvedValue([
      {
        id: 3,
        supplier_id: 3,
        category: 'rent',
        gross_amount: 12200,
        vat_amount: 2200,
        currency: 'EUR',
        tax_point_date: '2026-06-12',
        status: 'pending',
        reconciled: false,
        supplier_invoice_number: null,
      },
    ] as never);
  if (!keepMocks) vi.mocked(getInvoices).mockResolvedValue([] as never);
  if (!keepMocks)
    vi.mocked(getEntities).mockResolvedValue([
      {
        id: 3,
        role: 'supplier',
        country: 'EE',
        name: 'AS Merko Ehitus',
        goods_vs_services: null,
        tax_status: null,
      },
    ] as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(qc);
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <UnsavedChangesProvider onUnauthorized={() => undefined}>
        <MemoryRouter>
          <AppToaster />
          <LockSheet period={PERIOD} open onOpenChange={onOpenChange} />
        </MemoryRouter>
      </UnsavedChangesProvider>
    </QueryClientProvider>,
  );
  return { onOpenChange, qc };
}

describe('LockSheet', () => {
  it('states the consequences incl. redirect and NO unlock; confirm label carries the amount', async () => {
    mountSheet();
    expect(
      await screen.findByText(/declaration is frozen exactly as shown/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/rejected after closing/i)).toBeInTheDocument();
    expect(
      screen.getByText(/re-dated into the next open period/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/There is no unlock/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Close & freeze · VAT to pay 624.07 €',
      }),
    ).toBeInTheDocument();
  });

  it('typed confirmation gates the button; warnings NEVER block (ADR-0015)', async () => {
    vi.mocked(lockPeriod).mockResolvedValue({
      ...PERIOD,
      status: 'locked',
      filed_at: 1751500800,
    } as never);
    mountSheet([
      {
        type: 'pending_approval',
        object_type: 'expense',
        object_id: 3,
        description: 'Expense #3 (rent, EUR 12200) awaiting approval',
      },
    ]);
    // Human straggler line joined from the shared lists — never raw cents.
    expect(
      await screen.findByText(
        /AS Merko Ehitus · −122\.00 € — awaiting approval/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/EUR 12200/)).toBeNull();
    const confirm = screen.getByRole('button', {
      name: 'Close & freeze · VAT to pay 624.07 €',
    });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Type 2026-06 to confirm'), {
      target: { value: '2026-06' },
    });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(lockPeriod).toHaveBeenCalledWith(6));
    expect(
      await screen.findByText('June 2026 closed — declaration frozen'),
    ).toBeInTheDocument();
  });

  it('refuses to close via the sheet while the lock mutation is pending (vaul backdrop/swipe dismissal must not unmount the mutation observer)', async () => {
    // Never-resolving mock — the mutation stays pending for the life of the
    // test, mirroring a slow in-flight server locking the period.
    vi.mocked(lockPeriod).mockReturnValue(new Promise(() => {}));
    const { onOpenChange } = mountSheet();
    fireEvent.change(await screen.findByLabelText('Type 2026-06 to confirm'), {
      target: { value: '2026-06' },
    });
    const confirmButton = screen.getByRole('button', {
      name: 'Close & freeze · VAT to pay 624.07 €',
    });
    fireEvent.click(confirmButton);
    await waitFor(() => expect(lockPeriod).toHaveBeenCalled());
    await waitFor(() => expect(confirmButton).toBeDisabled());
    // Simulate the vaul dismiss path — Escape / backdrop click both route
    // through Drawer.Root's onOpenChange(false).
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    // The guard must refuse the close: onOpenChange(false) never reaches the
    // caller while the mutation observer is still in flight — the caller
    // never unmounts LockSheet, so the invalidate/receipt-toast in onSuccess
    // is not lost.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    // The sheet content is still mounted.
    expect(
      screen.getByText(/declaration is frozen exactly as shown/i),
    ).toBeInTheDocument();
    expect(confirmButton).toBeInTheDocument();
  });

  it('trims leading/trailing whitespace off the typed confirmation', async () => {
    mountSheet();
    const confirm = await screen.findByRole('button', {
      name: 'Close & freeze · VAT to pay 624.07 €',
    });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Type 2026-06 to confirm'), {
      target: { value: ' 2026-06 ' },
    });
    expect(confirm).toBeEnabled();
  });

  it('surfaces the in-order 409 verbatim and stays open', async () => {
    vi.mocked(lockPeriod).mockRejectedValue(
      new Error(
        'Cannot file period 2026-06: earlier period 2026-05 is still open — file it first',
      ),
    );
    const { onOpenChange } = mountSheet();
    fireEvent.change(await screen.findByLabelText('Type 2026-06 to confirm'), {
      target: { value: '2026-06' },
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Close & freeze · VAT to pay 624.07 €',
      }),
    );
    expect(
      await screen.findByText(/earlier period 2026-05 is still open/),
    ).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  describe('incomplete checks (issue #255)', () => {
    const CONFIRM_PLAIN = 'Close & freeze the declaration';
    const CONFIRM_AMOUNT = 'Close & freeze · VAT to pay 624.07 €';
    const ACK = /Close anyway without complete checks/;
    const typeName = (v = '2026-06') =>
      fireEvent.change(screen.getByLabelText('Type 2026-06 to confirm'), {
        target: { value: v },
      });

    it('failed warnings check: stated with Retry; typed name alone does not enable; explicit ack does', async () => {
      vi.mocked(getPeriodWarnings).mockRejectedValue(
        new Error('Service unavailable'),
      );
      vi.mocked(getKmd).mockResolvedValue(KMD as never);
      vi.mocked(lockPeriod).mockResolvedValue({
        ...PERIOD,
        status: 'locked',
      } as never);
      mountSheet([], undefined, true);
      expect(
        await screen.findByText(/could not check — Service unavailable/),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Retry undecided items' }),
      ).toBeInTheDocument();
      // Never reads as "none found".
      expect(screen.queryByText(/none found/)).toBeNull();
      const confirm = await screen.findByRole('button', {
        name: CONFIRM_AMOUNT,
      });
      typeName();
      expect(confirm).toBeDisabled();
      fireEvent.click(confirm);
      expect(lockPeriod).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('checkbox', { name: ACK }));
      expect(confirm).toBeEnabled();
      fireEvent.click(confirm);
      // The server request itself is unchanged — no force/bypass argument.
      await waitFor(() => expect(lockPeriod).toHaveBeenCalledWith(6));
    });

    it('never-resolving checks: "checking…", no amount claimed, name alone does not enable', async () => {
      vi.mocked(getPeriodWarnings).mockReturnValue(new Promise(() => {}));
      vi.mocked(getKmd).mockReturnValue(new Promise(() => {}));
      mountSheet([], undefined, true);
      expect(await screen.findAllByText('checking…')).toHaveLength(2);
      expect(
        screen.getByText(/frozen as the server computes it at closing/),
      ).toBeInTheDocument();
      expect(screen.queryByText(/frozen exactly as shown/)).toBeNull();
      const confirm = screen.getByRole('button', { name: CONFIRM_PLAIN });
      typeName();
      expect(confirm).toBeDisabled();
      fireEvent.click(screen.getByRole('checkbox', { name: ACK }));
      expect(confirm).toBeEnabled();
    });

    it('cache written in the SAME millisecond as the open + held on-open refresh: both checks incomplete, name alone never enables', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date('2026-06-30T10:00:00Z'));
        vi.mocked(getPeriodWarnings).mockReturnValue(new Promise(() => {}));
        vi.mocked(getKmd).mockReturnValue(new Promise(() => {}));
        mountSheet(
          [],
          (qc) => {
            // Same frozen timestamp as the sheet's mount.
            qc.setQueryData(reportsKeys.warnings(6), []);
            qc.setQueryData(reportsKeys.kmd(6), KMD);
          },
          true,
        );
        // Synchronously on first render — no enabled-button window.
        typeName();
        expect(
          screen.getByRole('button', { name: CONFIRM_PLAIN }),
        ).toBeDisabled();
        expect(screen.getAllByText('checking…')).toHaveLength(2);
        expect(screen.queryByText('none found')).toBeNull();
        expect(getPeriodWarnings).toHaveBeenCalledWith(6);
        expect(getKmd).toHaveBeenCalledWith(6);
        await act(async () => {});
        expect(
          screen.getByRole('button', { name: CONFIRM_PLAIN }),
        ).toBeDisabled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('fresh on-open results complete the checks: no ack needed, amount shown', async () => {
      mountSheet([], (qc) => {
        qc.setQueryData(reportsKeys.warnings(6), []);
        qc.setQueryData(reportsKeys.kmd(6), { ...KMD, net_vat_due: 1 });
      });
      const confirm = await screen.findByRole('button', {
        name: CONFIRM_AMOUNT,
      });
      expect(screen.getByText('none found')).toBeInTheDocument();
      expect(screen.queryByRole('checkbox', { name: ACK })).toBeNull();
      typeName();
      expect(confirm).toBeEnabled();
    });

    it('ack is voided when another check becomes incomplete, and when Retry fails again; typed name kept', async () => {
      vi.mocked(getPeriodWarnings).mockRejectedValue(new Error('503 first'));
      vi.mocked(getKmd).mockResolvedValue(KMD as never);
      const { qc } = mountSheet([], undefined, true);
      await screen.findByText(/could not check — 503 first/);
      typeName();
      const ack = screen.getByRole('checkbox', { name: ACK });
      fireEvent.click(ack);
      expect(
        screen.getByRole('button', { name: CONFIRM_AMOUNT }),
      ).toBeEnabled();

      // Another check (the declaration) fails on refresh → new incomplete set.
      vi.mocked(getKmd).mockRejectedValue(new Error('KMD down'));
      await act(async () => {
        await qc.refetchQueries({ queryKey: reportsKeys.kmd(6) });
      });
      expect(
        await screen.findByText(/could not refresh — KMD down/),
      ).toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: ACK })).not.toBeChecked();
      expect(
        screen.getByRole('button', { name: CONFIRM_PLAIN }),
      ).toBeDisabled();
      expect(screen.getByLabelText('Type 2026-06 to confirm')).toHaveValue(
        '2026-06',
      );

      // Re-ack, then a Retry that fails AGAIN (same message) voids it too.
      fireEvent.click(screen.getByRole('checkbox', { name: ACK }));
      expect(screen.getByRole('button', { name: CONFIRM_PLAIN })).toBeEnabled();
      vi.mocked(getPeriodWarnings).mockRejectedValue(new Error('503 first'));
      fireEvent.click(
        screen.getByRole('button', { name: 'Retry undecided items' }),
      );
      await waitFor(() => expect(getPeriodWarnings).toHaveBeenCalledTimes(2));
      await screen.findByText(/could not check — 503 first/);
      expect(screen.getByRole('checkbox', { name: ACK })).not.toBeChecked();
      expect(
        screen.getByRole('button', { name: CONFIRM_PLAIN }),
      ).toBeDisabled();
      expect(screen.getByLabelText('Type 2026-06 to confirm')).toHaveValue(
        '2026-06',
      );
    });

    it('Retry that succeeds completes the check without an ack', async () => {
      vi.mocked(getPeriodWarnings).mockRejectedValueOnce(new Error('503'));
      vi.mocked(getKmd).mockResolvedValue(KMD as never);
      mountSheet([], undefined, true);
      vi.mocked(getPeriodWarnings).mockResolvedValue([] as never);
      fireEvent.click(
        await screen.findByRole('button', { name: 'Retry undecided items' }),
      );
      expect(await screen.findByText('none found')).toBeInTheDocument();
      typeName();
      expect(
        screen.getByRole('button', { name: CONFIRM_AMOUNT }),
      ).toBeEnabled();
    });

    const WARNING = {
      type: 'pending_approval',
      object_type: 'expense',
      object_id: 3,
      description: 'Expense #3 (rent, EUR 12200) awaiting approval',
    };

    it('enrichment failure is labeled as missing details, separate from the complete server count; not a required check', async () => {
      vi.mocked(getPeriodWarnings).mockResolvedValue([WARNING] as never);
      vi.mocked(getKmd).mockResolvedValue(KMD as never);
      vi.mocked(getExpenses).mockRejectedValue(new Error('503'));
      vi.mocked(getInvoices).mockResolvedValue([] as never);
      vi.mocked(getEntities).mockResolvedValue([] as never);
      mountSheet([], undefined, true);
      expect(
        await screen.findByText('Expense — awaiting approval'),
      ).toBeInTheDocument();
      expect(await screen.findByText('1 found below')).toBeInTheDocument();
      expect(
        await screen.findByText(
          /details \(names and amounts\) unavailable — the count comes from the server check and is complete/,
        ),
      ).toBeInTheDocument();
      expect(screen.queryByRole('checkbox', { name: ACK })).toBeNull();
      typeName();
      expect(
        screen.getByRole('button', { name: CONFIRM_AMOUNT }),
      ).toBeEnabled();
    });

    it('cached warnings with a failed refresh + failed enrichment: the count is NOT claimed complete', async () => {
      vi.mocked(getPeriodWarnings).mockRejectedValue(new Error('503'));
      vi.mocked(getKmd).mockResolvedValue(KMD as never);
      vi.mocked(getExpenses).mockRejectedValue(new Error('503'));
      vi.mocked(getInvoices).mockResolvedValue([] as never);
      vi.mocked(getEntities).mockResolvedValue([] as never);
      mountSheet(
        [],
        (qc) => qc.setQueryData(reportsKeys.warnings(6), [WARNING]),
        true,
      );
      expect(
        await screen.findByText(/could not refresh — 503; earlier result/),
      ).toBeInTheDocument();
      expect(
        await screen.findByText(
          /the count is the last loaded result; whether it is current is unknown/,
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(/is complete/)).toBeNull();
      typeName();
      expect(
        screen.getByRole('button', { name: CONFIRM_AMOUNT }),
      ).toBeDisabled();
    });

    it('background enrichment failure over cached lists is labeled as possibly out-of-date details', async () => {
      vi.mocked(getPeriodWarnings).mockResolvedValue([WARNING] as never);
      vi.mocked(getKmd).mockResolvedValue(KMD as never);
      vi.mocked(getInvoices).mockResolvedValue([] as never);
      vi.mocked(getEntities).mockResolvedValue([] as never);
      vi.mocked(getExpenses).mockResolvedValue([] as never);
      const { qc } = mountSheet([], undefined, true);
      await screen.findByText('1 found below');
      vi.mocked(getExpenses).mockRejectedValue(new Error('503'));
      await act(async () => {
        await qc.refetchQueries({ queryKey: sharedKeys.expenses });
      });
      expect(
        await screen.findByText(
          /could not be refreshed and may be out of date — the count comes from the server check and is complete/,
        ),
      ).toBeInTheDocument();
    });
  });
});
