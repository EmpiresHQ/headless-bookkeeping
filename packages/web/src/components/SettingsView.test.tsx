import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SettingsView } from './SettingsView';
import * as api from '../api';

const baseOrg: api.Organization = {
  id: 1,
  country: 'EE',
  base_currency: null,
  vat_registered: false,
  org_type: 'company',
  created_at: 0,
  name: null,
  vat_registration_number: null,
  iban: null,
};

describe('SettingsView', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getSettings').mockResolvedValue([
      { key: 'ai_model', value: 'openai/gpt-4o' },
    ]);
    vi.spyOn(api, 'getPolicyConfig').mockResolvedValue({
      auto_post_amount_ceiling: 50000,
      auto_post_min_confidence: 0.9,
      unknown_supplier_requires_approval: true,
      always_approve_operations: [],
    });
    vi.spyOn(api, 'setSetting').mockResolvedValue({
      key: 'ai_model',
      value: 'x',
    });
    vi.spyOn(api, 'getOrganization').mockResolvedValue({ ...baseOrg });
    vi.spyOn(api, 'updateOrganization').mockImplementation((dto) =>
      Promise.resolve({ ...baseOrg, ...dto } as api.Organization),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows the current global model and saves an edit', async () => {
    render(<SettingsView />);

    const input = (await screen.findByLabelText(
      /global model/i,
    )) as HTMLInputElement;
    expect(input.value).toBe('openai/gpt-4o');

    fireEvent.change(input, { target: { value: 'anthropic/claude-3-5' } });
    fireEvent.click(screen.getByRole('button', { name: /save global model/i }));

    await waitFor(
      () =>
        expect(api.setSetting).toHaveBeenCalledWith(
          'ai_model',
          'anthropic/claude-3-5',
        ),
      { timeout: 5000 },
    );
  });

  it('shows the policy ceiling from policy-config', async () => {
    render(<SettingsView />);
    const ceiling = (await screen.findByLabelText(
      /amount ceiling/i,
    )) as HTMLInputElement;
    expect(ceiling.value).toBe('50000');
  });

  it('shows the IBAN input and saves an edit via updateOrganization', async () => {
    render(<SettingsView />);

    const input = (await screen.findByLabelText(/IBAN/i)) as HTMLInputElement;
    expect(input.value).toBe('');

    fireEvent.change(input, { target: { value: 'EE382200221020145685' } });
    fireEvent.click(screen.getByRole('button', { name: /save organization/i }));

    await waitFor(
      () =>
        expect(api.updateOrganization).toHaveBeenCalledWith(
          expect.objectContaining({ iban: 'EE382200221020145685' }),
        ),
      { timeout: 5000 },
    );
  });
});
