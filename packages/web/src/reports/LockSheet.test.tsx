import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppToaster } from '../ui/toast';
import { LockSheet } from './LockSheet';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  lockPeriod: vi.fn(),
  getPeriodWarnings: vi.fn(),
  getExpenses: vi.fn(),
  getInvoices: vi.fn(),
  getEntities: vi.fn(),
}));
import {
  getEntities,
  getExpenses,
  getInvoices,
  getPeriodWarnings,
  lockPeriod,
} from '../api';

const PERIOD = {
  id: 6,
  name: '2026-06',
  start_date: '2026-06-01',
  end_date: '2026-06-30',
  status: 'open' as const,
  filed_at: null,
};

function mountSheet(warnings: unknown[] = []) {
  vi.mocked(getPeriodWarnings).mockResolvedValue(warnings as never);
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
  vi.mocked(getInvoices).mockResolvedValue([] as never);
  vi.mocked(getEntities).mockResolvedValue([
    {
      id: 3,
      role: 'supplier',
      country: 'EE',
      name: 'AS Merko Ehitus',
      goods_vs_services: null,
    },
  ] as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AppToaster />
        <LockSheet
          period={PERIOD}
          netVatDueCents={62407}
          open
          onOpenChange={onOpenChange}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onOpenChange };
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
});
