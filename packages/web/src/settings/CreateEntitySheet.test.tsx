import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  onboardEntity: vi.fn(),
}));
import { onboardEntity, type Entity } from '../api';
import { AppToaster } from '../ui/toast';
import { CreateEntitySheet } from './CreateEntitySheet';

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const router = createMemoryRouter(
    [
      {
        path: '/settings/entities',
        element: <CreateEntitySheet open onClose={onClose} />,
      },
      { path: '/settings/entities/:id', element: <div>DETAIL</div> },
    ],
    { initialEntries: ['/settings/entities'] },
  );
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
      <AppToaster />
    </QueryClientProvider>,
  );
  return { router, onClose };
}

beforeEach(() => vi.clearAllMocks());

describe('CreateEntitySheet', () => {
  it('supplier: requires name, country and registration key; posts the exact payload', async () => {
    vi.mocked(onboardEntity).mockResolvedValue({
      id: 31,
      role: 'supplier',
      country: 'EE',
      name: 'Circle K Eesti AS',
      goods_vs_services: 'goods',
    } as Entity);
    const { router } = mount();
    const submit = () => screen.getByRole('button', { name: 'Add supplier' });
    expect(submit()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: ' Circle K Eesti AS ' },
    });
    fireEvent.change(screen.getByLabelText('Country'), {
      target: { value: 'EE' },
    });
    expect(submit()).toBeDisabled(); // still no registration key
    fireEvent.change(screen.getByLabelText('Registration key'), {
      target: { value: 'EE100511246' },
    });
    fireEvent.change(screen.getByLabelText('Goods or services'), {
      target: { value: 'goods' },
    });
    fireEvent.click(submit());
    await waitFor(() =>
      expect(onboardEntity).toHaveBeenCalledWith({
        role: 'supplier',
        name: 'Circle K Eesti AS',
        country: 'EE',
        registrationKey: 'EE100511246',
        goodsVsServices: 'goods',
      }),
    );
    // Navigates straight to the new entity's card.
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/settings/entities/31'),
    );
  });

  it('employee: swaps identity fields (email required, tg optional) — the ADR-0036 path', async () => {
    vi.mocked(onboardEntity).mockResolvedValue({
      id: 9,
      role: 'employee',
      country: 'EE',
      name: 'Mari Maasikas',
      goods_vs_services: null,
    } as Entity);
    mount();
    fireEvent.change(screen.getByLabelText('Role'), {
      target: { value: 'employee' },
    });
    // Supplier-only fields are GONE; identity fields appear.
    expect(screen.queryByLabelText('Registration key')).toBeNull();
    expect(screen.queryByLabelText('Goods or services')).toBeNull();
    expect(
      screen.getByText(
        'Appears in the claimant dropdown when uploading a receipt (reimbursement)',
      ),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Mari Maasikas' },
    });
    fireEvent.change(screen.getByLabelText('Country'), {
      target: { value: 'EE' },
    });
    const submit = screen.getByRole('button', { name: 'Add employee' });
    expect(submit).toBeDisabled(); // email required (server 400s without it)
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'mari@example.com' },
    });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(onboardEntity).toHaveBeenCalledWith({
        role: 'employee',
        name: 'Mari Maasikas',
        country: 'EE',
        email: 'mari@example.com',
      }),
    );
  });

  it('surfaces the server per-role 400 verbatim and stays open', async () => {
    vi.mocked(onboardEntity).mockRejectedValue(
      new Error('registrationKey is required for supplier/customer entities'),
    );
    const { onClose } = mount();
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'X' },
    });
    fireEvent.change(screen.getByLabelText('Country'), {
      target: { value: 'EE' },
    });
    fireEvent.change(screen.getByLabelText('Registration key'), {
      target: { value: 'k' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add supplier' }));
    expect(
      await screen.findByText(
        'registrationKey is required for supplier/customer entities',
      ),
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('typing a registration key, then switching role to employee, never leaks the key onto the wire', async () => {
    vi.mocked(onboardEntity).mockResolvedValue({
      id: 9,
      role: 'employee',
      country: 'EE',
      name: 'Mari Maasikas',
      goods_vs_services: null,
    } as Entity);
    mount();
    // Supplier form first: type a registration key…
    fireEvent.change(screen.getByLabelText('Registration key'), {
      target: { value: 'EE100511246' },
    });
    // …then change your mind about the role.
    fireEvent.change(screen.getByLabelText('Role'), {
      target: { value: 'employee' },
    });
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Mari Maasikas' },
    });
    fireEvent.change(screen.getByLabelText('Country'), {
      target: { value: 'EE' },
    });
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'mari@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add employee' }));
    // EXACT body: toHaveBeenCalledWith is deep-equal — a leaked
    // registrationKey (or stale tgUserId) key would fail this assert.
    await waitFor(() =>
      expect(onboardEntity).toHaveBeenCalledWith({
        role: 'employee',
        name: 'Mari Maasikas',
        country: 'EE',
        email: 'mari@example.com',
      }),
    );
  });
});
