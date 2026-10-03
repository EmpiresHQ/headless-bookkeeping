import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getOrganization: vi.fn(),
  updateOrganization: vi.fn(),
}));
import { getOrganization, updateOrganization, type Organization } from '../api';
import { HttpError } from '../auth';
import { sharedKeys } from '../queries/keys';
import { AppToaster } from '../ui/toast';
import { OrganizationScreen } from './OrganizationScreen';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';

const ORG: Organization = {
  id: 1,
  country: 'EE',
  base_currency: null,
  vat_registered: true,
  vat_registration_kind: 'ordinary',
  input_vat_entitlement: 'full',
  input_vat_deduction_permille: null,
  org_type: 'company',
  created_at: 0,
  name: 'Acme OÜ',
  registry_code: null,
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
      <UnsavedChangesProvider onUnauthorized={() => undefined}>
        <RouterProvider router={router} />
        <AppToaster />
      </UnsavedChangesProvider>
    </QueryClientProvider>,
  );
  return qc;
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
    fireEvent.change(screen.getByLabelText('Registry code'), {
      target: { value: ' 17499653 ' },
    });
    fireEvent.change(screen.getByLabelText('IBAN'), {
      target: { value: '  EE382200221020145685  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save organization' }));
    await waitFor(() =>
      expect(updateOrganization).toHaveBeenCalledWith({
        country: 'EE',
        org_type: 'company',
        vat_registered: true,
        vat_registration_kind: 'ordinary',
        input_vat_entitlement: 'full',
        input_vat_deduction_permille: null,
        base_currency: null,
        name: 'Acme OÜ',
        registry_code: '17499653',
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

  it('keeps a dirty draft through a background refetch (>staleTime tab-away)', async () => {
    const qc = mount();
    await waitFor(() =>
      expect(screen.getByLabelText('Name')).toHaveValue('Acme OÜ'),
    );
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Draft Name' },
    });
    // Simulate a background refetch (staleTime elapsed + refetchOnWindowFocus)
    // landing a fresh server snapshot in the cache while the operator is
    // mid-edit — the old `key={dataUpdatedAt}` remount used to clobber this.
    act(() => {
      qc.setQueryData(sharedKeys.organization, {
        ...ORG,
        name: 'Server Renamed Co',
      });
    });
    expect(screen.getByLabelText('Name')).toHaveValue('Draft Name');
  });

  it('adopts a background refetch while the draft is untouched', async () => {
    const qc = mount();
    await waitFor(() =>
      expect(screen.getByLabelText('Name')).toHaveValue('Acme OÜ'),
    );
    act(() => {
      qc.setQueryData(sharedKeys.organization, {
        ...ORG,
        name: 'Server Renamed Co',
      });
    });
    await waitFor(() =>
      expect(screen.getByLabelText('Name')).toHaveValue('Server Renamed Co'),
    );
  });

  describe('save status (whole-form scope)', () => {
    const orgStatus = () =>
      screen.getByRole('button', { name: 'Save organization' })
        .previousElementSibling as HTMLElement;
    const loaded = async () => {
      const qc = mount();
      await waitFor(() =>
        expect(screen.getByLabelText('Name')).toHaveValue('Acme OÜ'),
      );
      return qc;
    };
    const name = (v: string) =>
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: v } });

    it('lists every edited field and drops one edited back', async () => {
      await loaded();
      expect(orgStatus()).toHaveTextContent('No unsaved changes.');
      expect(
        screen.getByRole('button', { name: 'Save organization' }),
      ).toHaveAttribute('aria-describedby', orgStatus().id);
      name('New Name');
      fireEvent.change(screen.getByLabelText('IBAN'), {
        target: { value: 'EE38' },
      });
      expect(orgStatus()).toHaveTextContent(
        'Unsaved changes: Name, IBAN. Save organization stores the whole form.',
      );
      name('Acme OÜ');
      expect(orgStatus()).toHaveTextContent('Unsaved changes: IBAN.');
    });

    it('the normalized response becomes the baseline; a failed reload after it is qualified', async () => {
      vi.mocked(updateOrganization).mockResolvedValue({
        ...ORG,
        name: 'ACME OÜ',
        iban: 'EE382200221020145685',
      });
      vi.mocked(getOrganization)
        .mockResolvedValueOnce(ORG)
        .mockRejectedValue(new Error('503'));
      await loaded();
      name('acme oü');
      fireEvent.change(screen.getByLabelText('IBAN'), {
        target: { value: 'ee38 2200 2210 2014 5685' },
      });
      fireEvent.click(
        screen.getByRole('button', { name: 'Save organization' }),
      );
      await waitFor(() =>
        expect(orgStatus()).toHaveTextContent(
          'Saved — the fields show what the server stored.',
        ),
      );
      expect(screen.getByLabelText('Name')).toHaveValue('ACME OÜ');
      expect(screen.getByLabelText('IBAN')).toHaveValue('EE382200221020145685');
      await waitFor(() =>
        expect(orgStatus()).toHaveTextContent(
          'Could not refresh — compared with the last organization the server returned.',
        ),
      );
      expect(orgStatus()).toHaveTextContent('Saved');
    });

    it('edits typed during the save stay, unsaved, and are named', async () => {
      let finish!: (o: Organization) => void;
      vi.mocked(updateOrganization).mockReturnValue(
        new Promise((r) => {
          finish = r;
        }),
      );
      await loaded();
      name('Sent Name');
      fireEvent.click(
        screen.getByRole('button', { name: 'Save organization' }),
      );
      expect(orgStatus()).toHaveTextContent('Saving the whole organization…');
      name('Newer Name');
      expect(orgStatus()).toHaveTextContent(
        'Edits made after pressing Save are not included and stay unsaved.',
      );
      await act(async () => {
        finish({ ...ORG, name: 'Sent Name' });
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(orgStatus()).toHaveTextContent('Unsaved changes: Name.'),
      );
      expect(screen.getByLabelText('Name')).toHaveValue('Newer Name');
    });

    it('a 4xx is "Not saved"; a network failure is only "not confirmed" and re-reads', async () => {
      vi.mocked(updateOrganization).mockRejectedValueOnce(
        new HttpError(400, '400 Bad Request: country locked'),
      );
      await loaded();
      name('Draft');
      fireEvent.click(
        screen.getByRole('button', { name: 'Save organization' }),
      );
      await waitFor(() =>
        expect(orgStatus()).toHaveTextContent(
          'Not saved — 400 Bad Request: country locked. Your edits are kept.',
        ),
      );
      expect(getOrganization).toHaveBeenCalledTimes(1);
      vi.mocked(updateOrganization).mockRejectedValueOnce(
        new TypeError('Failed to fetch'),
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'Save organization' }),
      );
      await waitFor(() =>
        expect(orgStatus()).toHaveTextContent(
          'Save not confirmed — Failed to fetch. It may or may not have been stored; your edits are kept.',
        ),
      );
      await waitFor(() => expect(getOrganization).toHaveBeenCalledTimes(2));
      expect(screen.getByLabelText('Name')).toHaveValue('Draft');
    });
  });
});
