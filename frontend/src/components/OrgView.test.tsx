import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OrgView } from './OrgView';
import * as api from '../api';

vi.mock('../api', () => ({
  getOrganization: vi.fn(),
  updateOrganization: vi.fn(),
}));

const baseOrg = {
  id: 1,
  country: 'EE',
  base_currency: null,
  vat_registered: false,
  org_type: 'company',
  created_at: 0,
};

describe('OrgView', () => {
  beforeEach(() => {
    vi.mocked(api.getOrganization).mockResolvedValue({ ...baseOrg });
    vi.mocked(api.updateOrganization).mockImplementation((dto) =>
      Promise.resolve({ ...baseOrg, ...dto } as api.Organization),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it('loads the org and saves edited fields (blank base currency → null)', async () => {
    render(<OrgView />);

    // VAT toggle + currency typed; country left as EE.
    const vat = await screen.findByLabelText('VAT registered');
    fireEvent.click(vat);
    fireEvent.change(screen.getByLabelText('Base currency'), {
      target: { value: 'USD' },
    });

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText('Organization saved.')).toBeInTheDocument();
    expect(api.updateOrganization).toHaveBeenCalledWith({
      country: 'EE',
      org_type: 'company',
      vat_registered: true,
      base_currency: 'USD',
    });
  });

  it('sends base_currency: null when the field is left blank', async () => {
    render(<OrgView />);
    await screen.findByLabelText('Base currency');

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText('Organization saved.')).toBeInTheDocument();
    expect(api.updateOrganization).toHaveBeenCalledWith(
      expect.objectContaining({ base_currency: null }),
    );
  });
});
