import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getOrganization: vi.fn(),
  updateOrganization: vi.fn(),
}));
import { getOrganization, updateOrganization, type Organization } from '../api';
import { AppToaster } from '../ui/toast';
import { OrganizationScreen } from './OrganizationScreen';

const ORG: Organization = {
  id: 1,
  country: 'EE',
  base_currency: null,
  vat_registered: true,
  org_type: 'company',
  created_at: 0,
  name: 'Acme OÜ',
  vat_registration_number: 'EE123456789',
  iban: null,
};

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{ path: '/settings/organization', element: <OrganizationScreen /> }],
    { initialEntries: ['/settings/organization'] },
  );
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
      <AppToaster />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getOrganization).mockResolvedValue(ORG);
});

describe('OrganizationScreen', () => {
  it('prefills every field from the org (data rule 7)', async () => {
    mount();
    await waitFor(() =>
      expect(screen.getByLabelText('Name')).toHaveValue('Acme OÜ'),
    );
    expect(screen.getByLabelText('Country')).toHaveValue('EE');
    expect(screen.getByLabelText('Type')).toHaveValue('company');
    expect(screen.getByLabelText('VAT registered')).toBeChecked();
    expect(screen.getByLabelText('VAT registration number')).toHaveValue(
      'EE123456789',
    );
    expect(screen.getByLabelText('Base currency')).toHaveValue('');
  });

  it('saves the normalized field set and toasts a receipt', async () => {
    vi.mocked(updateOrganization).mockResolvedValue({
      ...ORG,
      iban: 'EE382200221020145685',
    });
    mount();
    await waitFor(() =>
      expect(screen.getByLabelText('Name')).toHaveValue('Acme OÜ'),
    );
    fireEvent.change(screen.getByLabelText('IBAN'), {
      target: { value: '  EE382200221020145685  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save organization' }));
    await waitFor(() =>
      expect(updateOrganization).toHaveBeenCalledWith({
        country: 'EE',
        org_type: 'company',
        vat_registered: true,
        base_currency: null,
        name: 'Acme OÜ',
        vat_registration_number: 'EE123456789',
        iban: 'EE382200221020145685', // trimmed
      }),
    );
    expect(await screen.findByText('Organization saved')).toBeInTheDocument();
  });

  it('blocks save on a malformed country and explains why', async () => {
    mount();
    await waitFor(() =>
      expect(screen.getByLabelText('Country')).toHaveValue('EE'),
    );
    fireEvent.change(screen.getByLabelText('Country'), {
      target: { value: 'Estonia' },
    });
    expect(
      screen.getByText('Two-letter ISO code, e.g. EE'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Save organization' }),
    ).toBeDisabled();
    expect(updateOrganization).not.toHaveBeenCalled();
  });

  it('surfaces a server failure verbatim and keeps the form editable', async () => {
    vi.mocked(updateOrganization).mockRejectedValue(
      new Error('Expected exactly 1 organization record, found 0'),
    );
    mount();
    await waitFor(() =>
      expect(screen.getByLabelText('Name')).toHaveValue('Acme OÜ'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save organization' }));
    expect(
      await screen.findByText(
        'Expected exactly 1 organization record, found 0',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Save organization' }),
    ).toBeEnabled();
  });

  it('renders LoadError with retry when the org read fails', async () => {
    vi.mocked(getOrganization).mockRejectedValue(new Error('boom'));
    mount();
    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
