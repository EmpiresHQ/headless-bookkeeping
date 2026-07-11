import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppToaster } from '../ui/toast';
import { CorrectSheet } from './CorrectSheet';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  correctExpense: vi.fn(),
  correctInvoice: vi.fn(),
  getCategories: vi.fn(),
}));
import { correctExpense, getCategories } from '../api';

beforeEach(() => {
  vi.clearAllMocks();
});

function mount(props: Partial<Parameters<typeof CorrectSheet>[0]> = {}) {
  vi.mocked(getCategories).mockResolvedValue([
    { key: 'rent', label: 'Rent', accountCode: 'X' },
    { key: 'fuel', label: 'Fuel', accountCode: 'Y' },
  ] as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onDone = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/books/expenses/12']}>
        <AppToaster />
        <Routes>
          <Route
            path="/books/expenses/:id"
            element={
              <CorrectSheet
                open
                onOpenChange={() => undefined}
                objectType="expense"
                objectId={12}
                grossCents={65000}
                vatCents={11721}
                category="rent"
                onDone={onDone}
                {...props}
              />
            }
          />
          <Route path="/books/credit-notes/new" element={<div>CN FORM</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onDone };
}

describe('CorrectSheet', () => {
  it('financial: prefilled euros, mandatory reason, outcome-stating submit, cents on the wire', async () => {
    vi.mocked(correctExpense).mockResolvedValue({
      outcome: 'posted_reversal_and_correction',
      redirected: false,
    } as never);
    const { onDone } = mount();
    const gross = await screen.findByLabelText('New gross (€)');
    expect(gross).toHaveValue('650.00');
    // Reason empty → primary disabled:
    const submit = screen.getByRole('button', { name: /Post correction/ });
    expect(submit).toBeDisabled();
    fireEvent.change(gross, { target: { value: '605,00' } });
    fireEvent.change(screen.getByLabelText('New VAT (€)'), {
      target: { value: '109.10' },
    });
    fireEvent.change(screen.getByLabelText('Reason'), {
      target: { value: 'OCR misread the total' },
    });
    expect(
      screen.getByRole('button', { name: 'Post correction · −605.00 €' }),
    ).toBeEnabled();
    fireEvent.click(
      screen.getByRole('button', { name: 'Post correction · −605.00 €' }),
    );
    await waitFor(() =>
      expect(correctExpense).toHaveBeenCalledWith(12, {
        kind: 'financial',
        reason: 'OCR misread the total',
        patch: { gross_amount: 60500, vat_amount: 10910, category: 'rent' },
      }),
    );
    expect(onDone).toHaveBeenCalled();
  });

  it('states the locked-period redirect in the receipt', async () => {
    vi.mocked(correctExpense).mockResolvedValue({
      outcome: 'posted_reversal_and_correction',
      redirected: true,
      redirectedToPeriodId: 5,
    } as never);
    mount();
    fireEvent.change(await screen.findByLabelText('Reason'), {
      target: { value: 'late fix' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Post correction/ }));
    expect(
      await screen.findByText(/landed in the current open period/i),
    ).toBeInTheDocument();
  });

  it('cosmetic: no patch fields, honest no-op hint, reason still mandatory, honest not-stored copy throughout', async () => {
    vi.mocked(correctExpense).mockResolvedValue({
      outcome: 'cosmetic_attachment_replaced',
    } as never);
    mount();
    fireEvent.click(await screen.findByLabelText(/Cosmetic/));
    expect(screen.queryByLabelText('New gross (€)')).toBeNull();
    expect(
      screen.getByText(/nothing changes in the books/i),
    ).toBeInTheDocument();
    // The hint must not claim the reason lands in the audit trail — the
    // server discards it for cosmetic corrections.
    expect(screen.getByText(/not stored/i)).toBeInTheDocument();
    expect(screen.queryByText(/lands in the audit trail/i)).toBeNull();
    fireEvent.change(screen.getByLabelText('Reason'), {
      target: { value: 'typo in note' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Record cosmetic correction' }),
    );
    await waitFor(() =>
      expect(correctExpense).toHaveBeenCalledWith(12, {
        kind: 'cosmetic',
        reason: 'typo in note',
      }),
    );
    // The success toast must not claim persistence either.
    expect(
      await screen.findByText(/not stored, nothing changed/i),
    ).toBeInTheDocument();
  });

  it('unsupported_status: the object was already corrected — no false success toast, sheet closes, queries invalidate', async () => {
    vi.mocked(correctExpense).mockResolvedValue({
      outcome: 'unsupported_status',
    } as never);
    const onOpenChange = vi.fn();
    const { onDone } = mount({ onOpenChange });
    fireEvent.change(await screen.findByLabelText('Reason'), {
      target: { value: 'trying to fix a typo' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Post correction/ }));
    expect(
      await screen.findByText(
        /already corrected \(corrections are one-shot\)/i,
      ),
    ).toBeInTheDocument();
    // No success toast — "Correction posted" would be a lie here.
    expect(screen.queryByText(/Correction posted/)).toBeNull();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onDone).toHaveBeenCalled();
  });

  it('credit note branch NAVIGATES to the prefilled form — no /correct call', async () => {
    mount();
    fireEvent.click(await screen.findByLabelText(/Credit note/));
    expect(
      screen.getByRole('link', { name: 'Open the credit-note form' }),
    ).toHaveAttribute('href', '/books/credit-notes/new?type=expense&id=12');
    fireEvent.click(
      screen.getByRole('link', { name: 'Open the credit-note form' }),
    );
    expect(await screen.findByText('CN FORM')).toBeInTheDocument();
    expect(correctExpense).not.toHaveBeenCalled();
  });
});
