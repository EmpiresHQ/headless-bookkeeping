import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getSettings: vi.fn(),
}));
import { getSettings } from '../api';
import { TelegramScreen } from './TelegramScreen';

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/settings/telegram']}>
        <TelegramScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSettings).mockResolvedValue([
    { key: 'approvers', value: 'tg:123' },
  ]);
});

describe('TelegramScreen', () => {
  it('renders the three Telegram keys plus approvers and email whitelist', async () => {
    mount();
    await waitFor(() =>
      expect(screen.getByLabelText('Approvers')).toHaveValue('tg:123'),
    );
    for (const label of [
      'Bot token',
      'Webhook secret',
      'Allowlist chat ids',
      'Approvers',
      'Email whitelist',
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.getByLabelText('Bot token')).toHaveAttribute(
      'type',
      'password',
    );
    // The honest operational caveat survives.
    expect(
      screen.getByText(/Restart the app after changing/),
    ).toBeInTheDocument();
  });
});
