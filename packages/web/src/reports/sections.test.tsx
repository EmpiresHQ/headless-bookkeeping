import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sharedKeys } from '../queries/keys';
import { AppToaster } from '../ui/toast';
import { InfGapsSection, InPeriodSection, StragglersSection } from './sections';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getExpenses: vi.fn(),
  getInvoices: vi.fn(),
  getEntities: vi.fn(),
  getPeriodWarnings: vi.fn(),
  setExpenseDocumentMetadata: vi.fn(),
}));
import {
  getEntities,
  getExpenses,
  getInvoices,
  getPeriodWarnings,
  setExpenseDocumentMetadata,
} from '../api';

const PERIOD = {
  id: 7,
  name: '2026-07',
  start_date: '2026-07-01',
  end_date: '2026-07-31',
  status: 'open' as const,
  filed_at: null,
};

const EXPENSES = [
  {
    id: 1,
    supplier_id: 3,
    category: 'rent',
    gross_amount: 122000,
    vat_amount: 22000,
    currency: 'EUR',
    tax_point_date: '2026-07-10',
    status: 'posted',
    reconciled: true,
    supplier_invoice_number: null,
  },
  {
    id: 2,
    supplier_id: 3,
    category: 'rent',
    gross_amount: 122000,
    vat_amount: 22000,
    currency: 'EUR',
    tax_point_date: '2026-07-11',
    status: 'posted',
    reconciled: false,
    supplier_invoice_number: 'A-9',
  },
  {
    id: 3,
    supplier_id: 3,
    category: 'rent',
    gross_amount: 12200,
    vat_amount: 2200,
    currency: 'EUR',
    tax_point_date: '2026-07-12',
    status: 'draft',
    reconciled: false,
    supplier_invoice_number: null,
  },
];

const INVOICES = [
  {
    id: 4,
    customer_id: 9,
    invoice_number: 'INV-12',
    gross_amount: 244000,
    vat_amount: 44000,
    currency: 'EUR',
    tax_point_date: '2026-07-05',
    due_date: null,
    document_id: null,
    status: 'posted',
    sent_at: null,
    reconciled: false,
  },
];

const ENTITIES = [
  {
    id: 3,
    role: 'supplier',
    country: 'EE',
    name: 'AS Merko Ehitus',
    goods_vs_services: null,
  },
  {
    id: 9,
    role: 'customer',
    country: 'EE',
    name: 'OÜ Klient',
    goods_vs_services: null,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

function mount(ui: ReactElement) {
  vi.mocked(getExpenses).mockResolvedValue(EXPENSES as never);
  vi.mocked(getInvoices).mockResolvedValue(INVOICES as never);
  vi.mocked(getEntities).mockResolvedValue(ENTITIES as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AppToaster />
        {ui}
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('InfGapsSection', () => {
  it('lists only real gap candidates with supplier titles, and fixes in place', async () => {
    vi.mocked(setExpenseDocumentMetadata).mockResolvedValue({
      id: 1,
      supplier_invoice_number: 'A-183',
    } as never);
    mount(<InfGapsSection period={PERIOD} />);
    // Expense 1: supplier net ≥ 1000 € and no number → the ONE gap row.
    expect(
      await screen.findByText('INF annex — invoice numbers to add'),
    ).toBeInTheDocument();
    const gapRow = screen.getByRole('button', { name: /AS Merko Ehitus/ });
    expect(screen.queryAllByRole('button', { name: /AS Merko/ })).toHaveLength(
      1,
    );
    // The honest approximation note is visible:
    expect(
      screen.getByText(/suppliers with over 1000\.00 € of purchases/i),
    ).toBeInTheDocument();
    fireEvent.click(gapRow);
    const input = await screen.findByLabelText('Supplier invoice number');
    fireEvent.change(input, { target: { value: 'A-183' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save number' }));
    await waitFor(() =>
      expect(setExpenseDocumentMetadata).toHaveBeenCalledWith(1, {
        supplier_invoice_number: 'A-183',
      }),
    );
    expect(await screen.findByText('Invoice number saved')).toBeInTheDocument();
  });

  it('locked period: gaps are read-only with an explanation, no sheet', async () => {
    mount(
      <InfGapsSection
        period={{ ...PERIOD, status: 'locked', filed_at: 1751500800 }}
      />,
    );
    expect(
      await screen.findByText('INF annex — invoice numbers to add'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/period is locked — numbers can no longer be edited/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /AS Merko Ehitus/ }),
    ).toBeNull();
  });

  it('renders nothing when there are no gaps', async () => {
    vi.mocked(getExpenses).mockResolvedValue([] as never);
    vi.mocked(getEntities).mockResolvedValue([] as never);
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container } = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <InfGapsSection period={PERIOD} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(getExpenses).toHaveBeenCalled());
    expect(container.textContent).not.toContain('INF annex');
  });

  it('Fix-invoice-number sheet resets across open/close/reopen', async () => {
    mount(<InfGapsSection period={PERIOD} />);
    fireEvent.click(
      await screen.findByRole('button', { name: /AS Merko Ehitus/ }),
    );
    fireEvent.change(await screen.findByLabelText('Supplier invoice number'), {
      target: { value: 'INV-HALF' },
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByLabelText('Supplier invoice number')).toBeNull(),
    );
    fireEvent.click(screen.getByRole('button', { name: /AS Merko Ehitus/ }));
    expect(await screen.findByLabelText('Supplier invoice number')).toHaveValue(
      '',
    );
  });
});

describe('StragglersSection', () => {
  it('shows typed rows joined against the shared lists — never the raw description', async () => {
    vi.mocked(getPeriodWarnings).mockResolvedValue([
      {
        type: 'pending_approval',
        object_type: 'expense',
        object_id: 3,
        description: 'Expense #3 (rent, EUR 12200) awaiting approval',
      },
      {
        type: 'unposted_draft',
        object_type: 'sales_invoice',
        object_id: 4,
        description: 'SalesInvoice #INV-12 (EUR 244000) still in draft',
      },
    ] as never);
    mount(<StragglersSection period={PERIOD} />);
    expect(
      await screen.findByText('Not decided in this period'),
    ).toBeInTheDocument();
    // Approval straggler → Inbox; draft straggler → Books drafts.
    expect(
      screen.getByRole('link', { name: /1 awaiting approval/ }),
    ).toHaveAttribute('href', '/inbox?seg=approvals');
    expect(
      screen.getByRole('link', { name: /1 invoice draft not posted/ }),
    ).toHaveAttribute('href', '/books?seg=invoices&status=draft');
    // Raw cents from the server description never render (Reality #8):
    expect(screen.queryByText(/EUR 244000/)).toBeNull();
  });

  it('renders nothing for a locked period (warnings are a pre-lock aid)', () => {
    const { container } = mount(
      <StragglersSection
        period={{ ...PERIOD, status: 'locked', filed_at: 1751500800 }}
      />,
    );
    // enabled=false → the query never fires and the section is null synchronously.
    expect(getPeriodWarnings).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Not decided');
  });
});

describe('InPeriodSection', () => {
  it('purchases + sales groups with totals; every row is a Books navigation', async () => {
    mount(<InPeriodSection period={PERIOD} />);
    expect(
      await screen.findByText('Purchases in this period'),
    ).toBeInTheDocument();
    expect(screen.getByText('−2440.00 € · 2')).toBeInTheDocument();
    expect(screen.getByText('Sales in this period')).toBeInTheDocument();
    expect(screen.getByText('+2440.00 € · 1')).toBeInTheDocument();
    // Draft expense 3 is NOT live → excluded from the count above.
    const expenseLinks = screen.getAllByRole('link', {
      name: /AS Merko Ehitus/,
    });
    expect(expenseLinks[0]).toHaveAttribute('href', '/books/expenses/2');
    expect(screen.getByRole('link', { name: /OÜ Klient/ })).toHaveAttribute(
      'href',
      '/books/invoices/4',
    );
    // The ADR-0009 redirect note is present, in human words:
    expect(
      screen.getByText(/re-dated into the next open period/i),
    ).toBeInTheDocument();
  });

  it('renders NOTHING until both lists resolved (no half-totals)', async () => {
    // mount() sets both to resolve — this needs invoices to hang, so it is
    // deliberately NOT used here (its defaults would race the override).
    vi.mocked(getExpenses).mockResolvedValue(EXPENSES as never);
    vi.mocked(getEntities).mockResolvedValue(ENTITIES as never);
    vi.mocked(getInvoices).mockReturnValue(new Promise(() => {})); // never resolves
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <InPeriodSection period={PERIOD} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // A bare waitFor(getExpenses called) resolves before the (already-
    // resolved) promise settles through React Query's cache + a re-render —
    // gate on the query's actual cache status instead, so the assertion
    // below runs strictly after expenses landed and invoices is still
    // pending (the only window the old either-list gate got wrong).
    await waitFor(() =>
      expect(qc.getQueryState(sharedKeys.expenses)?.status).toBe('success'),
    );
    expect(screen.queryByText(/Purchases in this period/)).toBeNull();
  });
});
