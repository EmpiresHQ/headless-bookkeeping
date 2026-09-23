import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getEntities: vi.fn(),
  onboardEntity: vi.fn(),
}));
import { getEntities, onboardEntity, type Entity } from '../api';
import { EntitiesScreen } from './EntitiesScreen';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';

const ROWS: Entity[] = [
  {
    id: 1,
    role: 'supplier',
    country: 'EE',
    name: 'Circle K Eesti AS',
    goods_vs_services: 'goods',
  },
  {
    id: 2,
    role: 'customer',
    country: 'FI',
    name: 'Acme Oy',
    goods_vs_services: null,
    tax_status: null,
  },
  {
    id: 3,
    role: 'employee',
    country: 'EE',
    name: 'Mari Maasikas',
    goods_vs_services: null,
    tax_status: null,
  },
] as Entity[];

function mount(initial = '/settings/entities') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/settings/entities', element: <EntitiesScreen /> },
      { path: '/settings/entities/:id', element: <div>DETAIL</div> },
    ],
    { initialEntries: [initial] },
  );
  render(
    <QueryClientProvider client={qc}>
      <UnsavedChangesProvider onUnauthorized={() => undefined}>
        <RouterProvider router={router} />
      </UnsavedChangesProvider>
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEntities).mockResolvedValue(ROWS);
});

describe('EntitiesScreen', () => {
  it('lists name + role chip + country, no raw ids (data rule 1)', async () => {
    mount();
    expect(await screen.findByText('Circle K Eesti AS')).toBeInTheDocument();
    expect(screen.getByText('Supplier')).toBeInTheDocument();
    expect(screen.getByText('Employee')).toBeInTheDocument();
    expect(screen.queryByText('#1')).toBeNull();
    expect(screen.queryByText(/^1$/)).toBeNull();
  });

  it('Team segment filters to ADR-0036 claimants and survives in ?seg=', async () => {
    const router = mount('/settings/entities?seg=team');
    expect(await screen.findByText('Mari Maasikas')).toBeInTheDocument();
    expect(screen.queryByText('Circle K Eesti AS')).toBeNull();
    // Round-trip: switching writes ?seg=.
    fireEvent.click(screen.getByRole('tab', { name: 'Suppliers' }));
    await waitFor(() =>
      expect(router.state.location.search).toContain('seg=suppliers'),
    );
    expect(await screen.findByText('Circle K Eesti AS')).toBeInTheDocument();
  });

  it('search narrows by name and persists in ?q=', async () => {
    const router = mount();
    await screen.findByText('Circle K Eesti AS');
    fireEvent.change(screen.getByPlaceholderText('Search entities'), {
      target: { value: 'mari' },
    });
    await waitFor(() =>
      expect(router.state.location.search).toContain('q=mari'),
    );
    expect(screen.getByText('Mari Maasikas')).toBeInTheDocument();
    expect(screen.queryByText('Acme Oy')).toBeNull();
  });

  it('honest empty state on a fresh install points at creation', async () => {
    vi.mocked(getEntities).mockResolvedValue([]);
    mount();
    expect(await screen.findByText('No entities yet')).toBeInTheDocument();
    expect(
      screen.getByText(/Suppliers and customers are created automatically/),
    ).toBeInTheDocument();
  });

  it('read failure → LoadError with retry', async () => {
    vi.mocked(getEntities).mockRejectedValue(new Error('boom'));
    mount();
    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('Team-empty state explains the claimant dropdown and preselects the employee role', async () => {
    // Suppliers/customers only — no team members on this install.
    vi.mocked(getEntities).mockResolvedValue([ROWS[0], ROWS[1]]);
    mount('/settings/entities?seg=team');
    expect(await screen.findByText('No team members yet')).toBeInTheDocument();
    expect(screen.getByText(/claimant dropdown/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add employee' }));
    expect(await screen.findByLabelText('Role')).toHaveValue('employee');
  });

  it('create sheet resets across open/close/reopen (remount-on-open discipline)', async () => {
    mount();
    await screen.findByText('Circle K Eesti AS');
    fireEvent.click(screen.getByRole('button', { name: '＋ Add' }));
    fireEvent.change(await screen.findByLabelText('Name'), {
      target: { value: 'Half-typed OÜ' },
    });
    fireEvent.change(screen.getByLabelText('Role'), {
      target: { value: 'employee' },
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    // Dirty: the guard asks first (issue #250) — discard it.
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByLabelText('Name')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '＋ Add' }));
    expect(await screen.findByLabelText('Name')).toHaveValue('');
    expect(screen.getByLabelText('Role')).toHaveValue('supplier');
  });

  describe('Add starts from the segment role (issue #264)', () => {
    const ALL_HINT =
      'Defaults to Supplier — change it for a customer, employee or director.';

    it('Customers → Add opens a customer form and posts role customer', async () => {
      vi.mocked(onboardEntity).mockResolvedValue({
        id: 41,
        role: 'customer',
        country: 'FI',
        name: 'Suomi Oy',
        goods_vs_services: null,
        tax_status: null,
      } as Entity);
      const router = mount('/settings/entities?seg=customers');
      await screen.findByText('Acme Oy');
      fireEvent.click(screen.getByRole('button', { name: '＋ Add' }));
      expect(await screen.findByLabelText('Role')).toHaveValue('customer');
      // Scoped segment: default matches the segment, no All-default note.
      expect(screen.queryByText(ALL_HINT)).toBeNull();
      fireEvent.change(screen.getByLabelText('Name'), {
        target: { value: 'Suomi Oy' },
      });
      fireEvent.change(screen.getByLabelText('Country'), {
        target: { value: 'FI' },
      });
      fireEvent.change(screen.getByLabelText('Registration key'), {
        target: { value: 'FI12345678' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Add customer' }));
      await waitFor(() =>
        expect(onboardEntity).toHaveBeenCalledWith({
          role: 'customer',
          name: 'Suomi Oy',
          country: 'FI',
          registrationKey: 'FI12345678',
          goodsVsServices: 'unknown',
          taxStatus: 'unknown',
        }),
      );
      await waitFor(() =>
        expect(router.state.location.pathname).toBe('/settings/entities/41'),
      );
    });

    it('Suppliers → supplier; Team → employee; neither shows the All note', async () => {
      mount('/settings/entities?seg=suppliers');
      await screen.findByText('Circle K Eesti AS');
      fireEvent.click(screen.getByRole('button', { name: '＋ Add' }));
      expect(await screen.findByLabelText('Role')).toHaveValue('supplier');
      expect(screen.queryByText(ALL_HINT)).toBeNull();
      // Untouched form closes without an unsaved-changes prompt: the guard
      // baseline is the segment role, not a hard-coded supplier.
      fireEvent.keyDown(document, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByLabelText('Role')).toBeNull());
      fireEvent.click(screen.getByRole('tab', { name: 'Team' }));
      await screen.findByText('Mari Maasikas');
      fireEvent.click(screen.getByRole('button', { name: '＋ Add' }));
      expect(await screen.findByLabelText('Role')).toHaveValue('employee');
      expect(screen.getByLabelText('Email')).toBeInTheDocument();
      expect(screen.queryByText(ALL_HINT)).toBeNull();
    });

    it('All keeps the documented supplier default, visibly stated', async () => {
      mount();
      await screen.findByText('Circle K Eesti AS');
      fireEvent.click(screen.getByRole('button', { name: '＋ Add' }));
      expect(await screen.findByLabelText('Role')).toHaveValue('supplier');
      expect(screen.getByText(ALL_HINT)).toBeInTheDocument();
    });

    it('empty-state Add in Customers also starts as customer', async () => {
      mount('/settings/entities?seg=customers&q=zzz');
      expect(await screen.findByText('Nothing matches')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Add entity' }));
      expect(await screen.findByLabelText('Role')).toHaveValue('customer');
    });

    it('no stale default across close → switch segment → reopen', async () => {
      mount('/settings/entities?seg=customers');
      await screen.findByText('Acme Oy');
      fireEvent.click(screen.getByRole('button', { name: '＋ Add' }));
      expect(await screen.findByLabelText('Role')).toHaveValue('customer');
      // Manual role switch stays allowed (Settings is general-purpose)…
      fireEvent.change(screen.getByLabelText('Role'), {
        target: { value: 'director' },
      });
      expect(screen.getByLabelText('Email')).toBeInTheDocument();
      fireEvent.keyDown(document, { key: 'Escape' });
      fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
      await waitFor(() => expect(screen.queryByLabelText('Role')).toBeNull());
      // …and never outlives the sheet: reopening from Suppliers is supplier.
      fireEvent.click(screen.getByRole('tab', { name: 'Suppliers' }));
      await screen.findByText('Circle K Eesti AS');
      fireEvent.click(screen.getByRole('button', { name: '＋ Add' }));
      expect(await screen.findByLabelText('Role')).toHaveValue('supplier');
      expect(screen.getByLabelText('Registration key')).toHaveValue('');
      fireEvent.keyDown(document, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByLabelText('Role')).toBeNull());
      fireEvent.click(screen.getByRole('tab', { name: 'Customers' }));
      await screen.findByText('Acme Oy');
      fireEvent.click(screen.getByRole('button', { name: '＋ Add' }));
      expect(await screen.findByLabelText('Role')).toHaveValue('customer');
    });
  });
});
