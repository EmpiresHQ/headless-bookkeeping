import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getSettings: vi.fn(),
  setSetting: vi.fn(),
}));
import { getSettings, setSetting } from '../api';
import { AppToaster } from '../ui/toast';
import { LlmScreen } from './LlmScreen';

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/settings/llm']}>
        <LlmScreen />
      </MemoryRouter>
      <AppToaster />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSettings).mockResolvedValue([
    { key: 'ai_model', value: 'openai/gpt-4o-mini' },
  ]);
});

describe('LlmScreen', () => {
  it('renders all eight AI keys, prefilled from the registry read', async () => {
    mount();
    await waitFor(() =>
      expect(screen.getByLabelText('Global model')).toHaveValue(
        'openai/gpt-4o-mini',
      ),
    );
    for (const label of [
      'Inference base URL',
      'API key',
      'Global model',
      'Model — triage',
      'Model — intent classifier',
      'Model — OCR',
      'Prompt — triage',
      'Prompt — intent classifier',
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    // Secrets are masked.
    expect(screen.getByLabelText('API key')).toHaveAttribute(
      'type',
      'password',
    );
  });

  it('saves a per-agent override to its dotted key', async () => {
    vi.mocked(setSetting).mockResolvedValue({
      key: 'ai_model.triage',
      value: 'openai/gpt-5-mini',
    });
    mount();
    await screen.findByLabelText('Model — triage');
    fireEvent.change(screen.getByLabelText('Model — triage'), {
      target: { value: 'openai/gpt-5-mini' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Save Model — triage' }),
    );
    await waitFor(() =>
      expect(setSetting).toHaveBeenCalledWith(
        'ai_model.triage',
        'openai/gpt-5-mini',
      ),
    );
  });
});
