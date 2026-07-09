import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { groupByMonth, matchesStatus } from '../queries/books';
import { ExpensesSegment } from './ExpensesSegment';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getExpenses: vi.fn(),
  getEntities: vi.fn(),
  getDocuments: vi.fn(),
}));
import { getDocuments, getEntities, getExpenses, type Expense } from '../api';

const EXPENSES: Expense[] = [
  {
    id: 1,
    supplier_id: 3,
    category: 'software',
    gross_amount: 8900,
    vat_amount: 1632,
    currency: 'EUR',
    tax_point_date: '2026-07-03',
    supplier_invoice_number: null,
    status: 'pending',
    reconciled: false,
  },
  {
    id: 2,
    supplier_id: 4,
    category: 'transport',
    gross_amount: 2490,
    vat_amount: 449,
    currency: 'EUR',
    tax_point_date: '2026-07-02',
    supplier_invoice_number: null,
    status: 'posted',
    reconciled: true,
  },
  {
    id: 3,
    supplier_id: null,
    category: 'fuel',
    gross_amount: 4820,
    vat_amount: 869,
    currency: 'EUR',
    tax_point_date: '2026-06-25',
    supplier_invoice_number: null,
    status: 'draft',
    reconciled: false,
  },
];
const ENTITIES = [
  {
    id: 3,
    role: 'supplier',
    country: 'EE',
    name: 'Telia Eesti AS',
    goods_vs_services: null,
  },
  {
    id: 4,
    role: 'supplier',
    country: 'EE',
    name: 'Bolt Operations OÜ',
    goods_vs_services: null,
  },
];
const DOCS = [{ id: 9, expense_id: 1 }];

function mount(q = '', url = '/books') {
  vi.mocked(getExpenses).mockResolvedValue(EXPENSES as never);
  vi.mocked(getEntities).mockResolvedValue(ENTITIES as never);
  vi.mocked(getDocuments).mockResolvedValue(DOCS as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <ExpensesSegment q={q} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('books pure model composition (filter -> groupByMonth totals)', () => {
  it('filtering to posted before grouping excludes the draft row from the group total', () => {
    const posted = EXPENSES.filter((r) => matchesStatus(r, 'posted'));
    const groups = groupByMonth(posted);
    // Only expense 2 (posted, 2490) survives the filter; the draft row's
    // 4820 and the pending row's 8900 must NOT bleed into any group total.
    expect(groups).toHaveLength(1);
    expect(groups[0].totalCents).toBe(2490);
    expect(groups[0].rows.map((r) => r.id)).toEqual([2]);
  });
});

describe('ExpensesSegment', () => {
  it('renders supplier-titled rows inside month sections with filtered totals', async () => {
    mount();
    expect(await screen.findByText('Telia Eesti AS')).toBeInTheDocument();
    expect(screen.getByText('Bolt Operations OÜ')).toBeInTheDocument();
    // Month headers with totals under the (empty) filter:
    expect(screen.getByText('July 2026')).toBeInTheDocument();
    expect(screen.getByText('−113.90 € · 2')).toBeInTheDocument();
    expect(screen.getByText('June 2026')).toBeInTheDocument();
    expect(screen.getByText('−48.20 € · 1')).toBeInTheDocument();
    // Supplier-less draft falls back to its category as the title:
    expect(screen.getByText('fuel')).toBeInTheDocument();
    // Row navigates to the detail route:
    expect(
      screen.getByRole('link', { name: /Telia Eesti AS/ }),
    ).toHaveAttribute('href', '/books/expenses/1');
  });

  it('marks reconciled rows with 🏦 and document-less rows with the 📎 marker', async () => {
    mount();
    await screen.findByText('Telia Eesti AS');
    // Expense 2 is reconciled; expense 1 has a document; 2 and 3 do not.
    expect(screen.getByText(/transport · 2 Jul · 🏦/)).toBeInTheDocument();
    expect(screen.getByText(/software · 3 Jul$/)).toBeInTheDocument();
    expect(
      screen.getByText(/fuel · 25 Jun · 📎 no document/),
    ).toBeInTheDocument();
  });

  it('status chips filter via ?status= and totals follow the filter', async () => {
    mount('', '/books?status=draft');
    await screen.findByText('fuel');
    expect(screen.queryByText('Telia Eesti AS')).not.toBeInTheDocument();
    expect(screen.getByText('−48.20 € · 1')).toBeInTheDocument();
    expect(screen.queryByText('July 2026')).not.toBeInTheDocument();
  });

  it('search narrows rows and recomputes totals', async () => {
    mount('telia');
    await screen.findByText('Telia Eesti AS');
    expect(screen.queryByText('Bolt Operations OÜ')).not.toBeInTheDocument();
    expect(screen.getByText('−89.00 € · 1')).toBeInTheDocument();
  });

  it('list error renders a retryable LoadError', async () => {
    vi.mocked(getExpenses).mockRejectedValue(new Error('boom'));
    vi.mocked(getEntities).mockResolvedValue(ENTITIES as never);
    vi.mocked(getDocuments).mockResolvedValue(DOCS as never);
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/books']}>
          <ExpensesSegment q="" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('the no-document chip toggles ?nodoc=1', async () => {
    mount();
    await screen.findByText('Telia Eesti AS');
    await userEvent.click(screen.getByRole('button', { name: /No document/ }));
    // Only expenses WITHOUT a linked document remain (ids 2 and 3).
    expect(screen.queryByText('Telia Eesti AS')).not.toBeInTheDocument();
    expect(screen.getByText('Bolt Operations OÜ')).toBeInTheDocument();
    expect(screen.getByText('fuel')).toBeInTheDocument();
  });

  it('suppresses the 📎 marker AND the no-document chip count while the archive query is still loading — no false "no document" flash', async () => {
    vi.mocked(getExpenses).mockResolvedValue(EXPENSES as never);
    vi.mocked(getEntities).mockResolvedValue(ENTITIES as never);
    // Never resolves — pins docsQ in the pending state for the assertion.
    vi.mocked(getDocuments).mockReturnValue(new Promise(() => {}) as never);
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/books']}>
          <ExpensesSegment q="" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Telia Eesti AS')).toBeInTheDocument();
    expect(screen.queryByText(/📎 no document/)).toBeNull();
    expect(
      screen.getByRole('button', { name: /No document 0/ }),
    ).toBeInTheDocument();
  });
});
