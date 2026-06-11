import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SettingsView } from './SettingsView';
import * as api from '../api';

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
});
