import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getMailboxConnectors: vi.fn(),
  getSettings: vi.fn(),
  createMailboxConnector: vi.fn(),
  deleteMailboxConnector: vi.fn(),
  startMailboxOAuth: vi.fn(),
  syncMailboxConnector: vi.fn(),
}));
import {
  createMailboxConnector,
  deleteMailboxConnector,
  getMailboxConnectors,
  getSettings,
  startMailboxOAuth,
  syncMailboxConnector,
  type MailboxConnector,
} from '../api';
import { AppToaster } from '../ui/toast';
import { MailboxScreen } from './MailboxScreen';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';

const CONNECTOR: MailboxConnector = {
  id: 4,
  channel: 'email_sync',
  auth_mode: 'password',
  provider: 'imap',
  host: 'imap.example.com',
  port: 993,
  username: 'me@example.com',
  folder: 'INBOX',
  status: 'auth_failed',
  last_synced_at: 1751600000,
  last_error: 'Invalid credentials (Failure)',
} as MailboxConnector;

function mount(initial = '/settings/mailbox') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{ path: '/settings/mailbox', element: <MailboxScreen /> }],
    { initialEntries: [initial] },
  );
  render(
    <QueryClientProvider client={qc}>
      <UnsavedChangesProvider onUnauthorized={() => undefined}>
        <RouterProvider router={router} />
        <AppToaster />
      </UnsavedChangesProvider>
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMailboxConnectors).mockResolvedValue([CONNECTOR]);
  vi.mocked(getSettings).mockResolvedValue([]);
});

afterEach(() => {
  // The OAuth test installs a window.location GETTER spy — without restore
  // it outlives its test (P06 T9 deferred).
  vi.restoreAllMocks();
});

describe('MailboxScreen', () => {
  it('shows the connector with status chip AND the last error visible (asset §9+)', async () => {
    mount();
    expect(await screen.findByText('me@example.com')).toBeInTheDocument();
    expect(screen.getByText('auth failed')).toBeInTheDocument();
    expect(
      screen.getByText(/Invalid credentials \(Failure\)/),
    ).toBeInTheDocument();
    // No fake fetch-count editor (Reality #3) — the note explains instead.
    expect(screen.queryByLabelText('Initial fetch count')).toBeNull();
    expect(
      screen.getByText(/Initial fetch depth is server-configured/),
    ).toBeInTheDocument();
  });

  it('per-row Sync calls the endpoint and refreshes', async () => {
    vi.mocked(syncMailboxConnector).mockResolvedValue({
      ...CONNECTOR,
      status: 'connected',
      last_error: null,
    });
    mount();
    await screen.findByText('me@example.com');
    fireEvent.click(
      screen.getByRole('button', { name: 'Sync me@example.com' }),
    );
    await waitFor(() => expect(syncMailboxConnector).toHaveBeenCalledWith(4));
  });

  it('Remove is confirm-gated and deletes', async () => {
    vi.mocked(deleteMailboxConnector).mockResolvedValue(undefined);
    mount();
    await screen.findByText('me@example.com');
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove me@example.com' }),
    );
    expect(deleteMailboxConnector).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove mailbox' }));
    await waitFor(() => expect(deleteMailboxConnector).toHaveBeenCalledWith(4));
  });

  it('adds an IMAP connector through the sheet with the exact payload', async () => {
    vi.mocked(createMailboxConnector).mockResolvedValue(CONNECTOR);
    mount();
    await screen.findByText('me@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Add IMAP mailbox…' }));
    fireEvent.change(screen.getByLabelText('IMAP host'), {
      target: { value: 'imap.example.com' },
    });
    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: 'me@example.com' },
    });
    fireEvent.change(screen.getByLabelText('App password'), {
      target: { value: 's3cret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add mailbox' }));
    await waitFor(() =>
      expect(createMailboxConnector).toHaveBeenCalledWith({
        channel: 'email_sync',
        provider: 'imap',
        host: 'imap.example.com',
        port: 993,
        username: 'me@example.com',
        secret: 's3cret',
        folder: 'INBOX',
      }),
    );
  });

  it.each([
    ['blank', ''],
    ['zero', '0'],
    ['negative', '-5'],
    ['out of range', '65536'],
    ['fractional', '993.5'],
  ])(
    'an invalid (%s) IMAP port disables Add mailbox, sends nothing, and keeps the typed fields (issue #376)',
    async (_label, badPort) => {
      mount();
      await screen.findByText('me@example.com');
      fireEvent.click(
        screen.getByRole('button', { name: 'Add IMAP mailbox…' }),
      );
      fireEvent.change(screen.getByLabelText('IMAP host'), {
        target: { value: 'imap.example.com' },
      });
      fireEvent.change(screen.getByLabelText('Username'), {
        target: { value: 'me@example.com' },
      });
      fireEvent.change(screen.getByLabelText('App password'), {
        target: { value: 's3cret' },
      });
      const add = screen.getByRole('button', { name: 'Add mailbox' });
      expect(add).toBeEnabled();

      fireEvent.change(screen.getByLabelText('Port'), {
        target: { value: badPort },
      });
      expect(add).toBeDisabled();
      expect(screen.getByLabelText('Port')).toHaveAttribute(
        'aria-invalid',
        'true',
      );
      expect(
        screen.getByText('Enter a port from 1 to 65535'),
      ).toBeInTheDocument();
      fireEvent.click(add);
      expect(createMailboxConnector).not.toHaveBeenCalled();
      expect(screen.getByLabelText('IMAP host')).toHaveValue(
        'imap.example.com',
      );
      expect(screen.getByLabelText('Username')).toHaveValue('me@example.com');
      expect(screen.getByLabelText('App password')).toHaveValue('s3cret');
    },
  );

  it('a corrected IMAP port re-enables Add mailbox and sends that port', async () => {
    vi.mocked(createMailboxConnector).mockResolvedValue(CONNECTOR);
    mount();
    await screen.findByText('me@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Add IMAP mailbox…' }));
    fireEvent.change(screen.getByLabelText('IMAP host'), {
      target: { value: 'imap.example.com' },
    });
    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: 'me@example.com' },
    });
    fireEvent.change(screen.getByLabelText('App password'), {
      target: { value: 's3cret' },
    });
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '' } });
    const add = screen.getByRole('button', { name: 'Add mailbox' });
    expect(add).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Port'), {
      target: { value: '143' },
    });
    expect(add).toBeEnabled();
    expect(
      screen.queryByText('Enter a port from 1 to 65535'),
    ).not.toBeInTheDocument();
    fireEvent.click(add);
    await waitFor(() =>
      expect(createMailboxConnector).toHaveBeenCalledWith(
        expect.objectContaining({ port: 143 }),
      ),
    );
  });

  it('OAuth return params surface as a toast and are stripped from the URL', async () => {
    const router = mount('/settings/mailbox?mailbox=connected');
    expect(await screen.findByText('Mailbox connected')).toBeInTheDocument();
    await waitFor(() =>
      expect(router.state.location.search).not.toContain('mailbox'),
    );
  });

  it('OAuth error param surfaces verbatim', async () => {
    mount('/settings/mailbox?mailbox_error=consent_denied');
    expect(await screen.findByText('consent_denied')).toBeInTheDocument();
  });

  it('Connect Gmail starts the OAuth round-trip', async () => {
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      assign,
    } as never);
    vi.mocked(startMailboxOAuth).mockResolvedValue({
      url: 'https://accounts.google.com/o/oauth2/x',
    });
    mount();
    await screen.findByText('me@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Connect Gmail' }));
    await waitFor(() =>
      expect(startMailboxOAuth).toHaveBeenCalledWith({
        provider: 'gmail',
        channel: 'email_sync',
      }),
    );
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        'https://accounts.google.com/o/oauth2/x',
      ),
    );
  });

  it('IMAP sheet resets across open/close/reopen', async () => {
    mount();
    await screen.findByText('me@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Add IMAP mailbox…' }));
    fireEvent.change(await screen.findByLabelText('IMAP host'), {
      target: { value: 'imap.half-typed.example' },
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    // Dirty: the guard asks first (issue #250) — discard it.
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() =>
      expect(screen.queryByLabelText('IMAP host')).toBeNull(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add IMAP mailbox…' }));
    expect(await screen.findByLabelText('IMAP host')).toHaveValue('');
  });
});
