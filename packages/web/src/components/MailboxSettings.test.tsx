import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MailboxSettings } from './MailboxSettings';
import * as api from '../api';
import type { MailboxConnector } from '../api';

const conn = (over: Partial<MailboxConnector> = {}): MailboxConnector => ({
  id: 1,
  channel: 'email_sync',
  auth_mode: 'password',
  provider: 'imap',
  host: 'imap.x',
  port: 993,
  username: 'me@x.com',
  folder: 'INBOX',
  status: 'connected',
  last_synced_at: null,
  last_error: null,
  ...over,
});

describe('MailboxSettings', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getMailboxConnectors').mockResolvedValue([]);
    vi.spyOn(api, 'createMailboxConnector').mockResolvedValue(conn());
    vi.spyOn(api, 'deleteMailboxConnector').mockResolvedValue(undefined);
    vi.spyOn(api, 'startMailboxOAuth').mockResolvedValue({
      url: 'https://consent.example/oauth',
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('lists connectors with their status', async () => {
    vi.mocked(api.getMailboxConnectors).mockResolvedValue([
      conn({
        id: 7,
        username: 'a@gmail.com',
        auth_mode: 'oauth',
        provider: 'gmail',
        status: 'connected',
      }),
      conn({
        id: 8,
        username: 'b@x.com',
        status: 'auth_failed',
        last_error: 'token revoked',
      }),
    ]);
    render(<MailboxSettings />);

    expect(await screen.findByText('a@gmail.com')).toBeInTheDocument();
    expect(screen.getByText('b@x.com')).toBeInTheDocument();
    expect(screen.getByText(/auth_failed/)).toBeInTheDocument();
    expect(screen.getByText(/token revoked/)).toBeInTheDocument();
  });

  it('shows an empty state when no mailboxes are connected', async () => {
    render(<MailboxSettings />);
    expect(
      await screen.findByText(/no mailboxes connected/i),
    ).toBeInTheDocument();
  });

  it('adds an IMAP password connector and reloads the list', async () => {
    render(<MailboxSettings />);
    await screen.findByText(/no mailboxes connected/i);

    fireEvent.change(screen.getByLabelText('IMAP host'), {
      target: { value: 'imap.fastmail.com' },
    });
    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: 'me@fastmail.com' },
    });
    fireEvent.change(screen.getByLabelText('App password'), {
      target: { value: 'app-pass-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add mailbox/i }));

    await waitFor(() =>
      expect(api.createMailboxConnector).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'email_sync',
          provider: 'imap',
          host: 'imap.fastmail.com',
          port: 993,
          username: 'me@fastmail.com',
          secret: 'app-pass-123',
          folder: 'INBOX',
        }),
      ),
    );
    // reloads after a successful create
    await waitFor(() =>
      expect(api.getMailboxConnectors).toHaveBeenCalledTimes(2),
    );
  });

  it('removes a connector', async () => {
    vi.mocked(api.getMailboxConnectors).mockResolvedValue([
      conn({ id: 42, username: 'gone@x.com' }),
    ]);
    render(<MailboxSettings />);

    fireEvent.click(
      await screen.findByRole('button', { name: /remove gone@x\.com/i }),
    );
    await waitFor(() =>
      expect(api.deleteMailboxConnector).toHaveBeenCalledWith(42),
    );
  });

  it('starts the Gmail OAuth flow and redirects to the consent url', async () => {
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, assign },
    });
    vi.spyOn(window, 'prompt').mockReturnValue('owner@gmail.com');

    render(<MailboxSettings />);
    await screen.findByText(/no mailboxes connected/i);
    fireEvent.click(screen.getByRole('button', { name: /connect gmail/i }));

    await waitFor(() =>
      expect(api.startMailboxOAuth).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'gmail',
          username: 'owner@gmail.com',
          host: 'imap.gmail.com',
          channel: 'email_sync',
        }),
      ),
    );
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('https://consent.example/oauth'),
    );
  });
});
