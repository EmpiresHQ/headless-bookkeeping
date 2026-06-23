import { useEffect, useState } from 'react';
import {
  getMailboxConnectors,
  createMailboxConnector,
  deleteMailboxConnector,
  startMailboxOAuth,
  type MailboxConnector,
  type MailboxChannel,
  type MailboxProvider,
} from '../api';

const STATUS_STYLE: Record<MailboxConnector['status'], string> = {
  connected: 'text-green-700',
  auth_failed: 'text-red-600',
  disconnected: 'text-amber-700',
  error: 'text-red-600',
};

function formatSynced(ts: number | null): string {
  return ts ? new Date(ts * 1000).toLocaleString() : 'never';
}

export function MailboxSettings() {
  const [connectors, setConnectors] = useState<MailboxConnector[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // IMAP + app-password form
  const [channel, setChannel] = useState<MailboxChannel>('email_sync');
  const [provider, setProvider] = useState<MailboxProvider>('imap');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('993');
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  const [folder, setFolder] = useState('INBOX');

  const load = () =>
    getMailboxConnectors()
      .then(setConnectors)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => void load(), []);

  // Read the result of an OAuth round-trip: the server callback redirects the
  // browser back to /?mailbox=connected (or ?mailbox_error=...). Surface it,
  // then strip the params so a refresh doesn't replay the banner.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('mailbox') === 'connected') setNote('Mailbox connected.');
    const err = params.get('mailbox_error');
    if (err) setError(err);
    if (params.has('mailbox') || params.has('mailbox_error')) {
      params.delete('mailbox');
      params.delete('mailbox_error');
      const qs = params.toString();
      window.history.replaceState(
        {},
        '',
        window.location.pathname + (qs ? `?${qs}` : ''),
      );
    }
  }, []);

  const fail = (e: unknown) =>
    setError(e instanceof Error ? e.message : String(e));

  const addPasswordConnector = async () => {
    setError(null);
    setBusy(true);
    try {
      await createMailboxConnector({
        channel,
        provider,
        host: host.trim(),
        port: Number(port),
        username: username.trim(),
        secret,
        folder: folder.trim() || undefined,
      });
      setHost('');
      setUsername('');
      setSecret('');
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const connectOAuth = async (oauthProvider: 'gmail' | 'outlook') => {
    setError(null);
    const user = window.prompt(`${oauthProvider} address to connect:`)?.trim();
    if (!user) return;
    const oauthHost =
      oauthProvider === 'gmail' ? 'imap.gmail.com' : 'outlook.office365.com';
    try {
      const { url } = await startMailboxOAuth({
        provider: oauthProvider,
        channel,
        host: oauthHost,
        username: user,
      });
      window.location.assign(url);
    } catch (e) {
      fail(e);
    }
  };

  const remove = async (id: number) => {
    setError(null);
    try {
      await deleteMailboxConnector(id);
      await load();
    } catch (e) {
      fail(e);
    }
  };

  return (
    <section className="space-y-4">
      <h2 className="font-semibold">Mail intake</h2>
      <p className="text-xs text-gray-500">
        Connect mailboxes to harvest invoice attachments into intake.{' '}
        <span className="font-medium">email_sync</span> polls your own inbox (a
        firehose — read-only); <span className="font-medium">email_push</span>{' '}
        is a single dedicated accounting mailbox. Credentials are encrypted at
        rest; access is read-only.
      </p>

      {note && <p className="text-sm text-green-700">{note}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {connectors !== null && connectors.length === 0 && (
        <p className="text-sm text-gray-500">No mailboxes connected.</p>
      )}
      {connectors !== null && connectors.length > 0 && (
        <ul className="divide-y rounded border">
          {connectors.map((c) => (
            <li
              key={c.id}
              className="flex items-start justify-between gap-2 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate font-mono text-sm">{c.username}</div>
                <div className="text-xs text-gray-500">
                  {c.channel} · {c.provider} · {c.auth_mode}
                </div>
                <div className={`text-xs ${STATUS_STYLE[c.status]}`}>
                  {c.status} · last synced {formatSynced(c.last_synced_at)}
                  {c.last_error ? ` · ${c.last_error}` : ''}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void remove(c.id)}
                aria-label={`Remove ${c.username}`}
                className="shrink-0 text-sm text-gray-600 hover:underline"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void connectOAuth('gmail')}
          className="rounded bg-black px-3 py-1 text-sm text-white"
        >
          Connect Gmail
        </button>
        <button
          type="button"
          onClick={() => void connectOAuth('outlook')}
          className="rounded bg-black px-3 py-1 text-sm text-white"
        >
          Connect Outlook
        </button>
      </div>

      <details className="rounded border px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium">
          Add IMAP mailbox (app password)
        </summary>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-gray-700">Mode</span>
            <select
              aria-label="Mailbox mode"
              value={channel}
              onChange={(e) => setChannel(e.target.value as MailboxChannel)}
              className="rounded border px-2 py-1"
            >
              <option value="email_sync">email_sync (your inbox)</option>
              <option value="email_push">email_push (dedicated)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-gray-700">Provider</span>
            <select
              aria-label="Provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value as MailboxProvider)}
              className="rounded border px-2 py-1"
            >
              <option value="imap">imap</option>
              <option value="gmail">gmail</option>
              <option value="outlook">outlook</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-gray-700">IMAP host</span>
            <input
              aria-label="IMAP host"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="imap.example.com"
              className="rounded border px-2 py-1 font-mono"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-gray-700">Port</span>
            <input
              aria-label="Port"
              type="number"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              className="rounded border px-2 py-1 font-mono"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-gray-700">Username</span>
            <input
              aria-label="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="me@example.com"
              className="rounded border px-2 py-1 font-mono"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-gray-700">App password</span>
            <input
              aria-label="App password"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              className="rounded border px-2 py-1 font-mono"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-gray-700">Folder</span>
            <input
              aria-label="Folder"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              className="rounded border px-2 py-1 font-mono"
            />
          </label>
        </div>
        <button
          type="button"
          disabled={
            busy ||
            host.trim().length === 0 ||
            username.trim().length === 0 ||
            secret.length === 0
          }
          onClick={() => void addPasswordConnector()}
          className="mt-3 rounded bg-black px-3 py-1 text-sm text-white disabled:opacity-50"
        >
          Add mailbox
        </button>
      </details>
    </section>
  );
}
