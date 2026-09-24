import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  createMailboxConnector,
  type MailboxChannel,
  type MailboxProvider,
} from '../api';
import { invalidateMailbox } from '../queries/settings';
import { Button } from '../ui/Button';
import { Field, PendingFieldset, SelectInput, TextInput } from '../ui/Form';
import { Sheet } from '../ui/Sheet';
import { toastErr, toastOk } from '../ui/toast';
import { usePendingOperation } from '../lib/pendingOperation';
import { useUnsavedChanges } from '../lib/unsavedChanges';

/** A TCP port: whole number 1–65535, else null. Mirrors the server's
 *  connector schema so an empty field never becomes `Number('') === 0`
 *  (issue #376). */
export function parseImapPort(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 65535 ? n : null;
}

/** App-password IMAP connector (Reality #9). Credentials are encrypted at
 *  rest server-side; access is read-only. */
export function AddImapSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const op = usePendingOperation('Add mailbox');
  const busy = op.pending;
  const [channel, setChannel] = useState<MailboxChannel>('email_sync');
  const [provider, setProvider] = useState<MailboxProvider>('imap');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('993');
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  const [folder, setFolder] = useState('INBOX');
  const values = { channel, provider, host, port, username, secret, folder };
  const [baseline] = useState(values);
  const guard = useUnsavedChanges({
    label: 'Add IMAP mailbox',
    active: open,
    values,
    baseline,
  });

  const portNumber = parseImapPort(port);
  const valid =
    host.trim() !== '' &&
    portNumber !== null &&
    username.trim() !== '' &&
    secret.length > 0;

  const submit = () => {
    if (!valid || portNumber === null) return;
    op.run(
      () =>
        createMailboxConnector({
          channel,
          provider,
          host: host.trim(),
          port: portNumber,
          username: username.trim(),
          secret,
          folder: folder.trim() || undefined,
        }),
      {
        onSuccess: () => {
          toastOk(`Mailbox added — ${username.trim()}`);
          guard.release();
          onClose();
          void invalidateMailbox(qc);
        },
        onError: (e) => {
          // Includes the server's MAILBOX_SECRET_KEY guidance verbatim.
          toastErr(e instanceof Error ? e.message : String(e));
        },
      },
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      guard={guard}
      busy={busy}
      title="Add IMAP mailbox"
    >
      <PendingFieldset pending={busy} className="space-y-4 px-6 pb-2">
        <Field
          label="Mode"
          hint="email_sync polls your own inbox (read-only firehose); email_push is a single dedicated accounting mailbox"
        >
          <SelectInput
            aria-label="Mode"
            value={channel}
            onChange={(e) => setChannel(e.target.value as MailboxChannel)}
          >
            <option value="email_sync">Your inbox (email_sync)</option>
            <option value="email_push">Dedicated mailbox (email_push)</option>
          </SelectInput>
        </Field>
        <Field label="Provider">
          <SelectInput
            aria-label="Provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value as MailboxProvider)}
          >
            <option value="imap">IMAP</option>
            <option value="gmail">Gmail</option>
            <option value="outlook">Outlook</option>
          </SelectInput>
        </Field>
        <Field label="IMAP host">
          <TextInput
            aria-label="IMAP host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="imap.example.com"
          />
        </Field>
        <Field
          label="Port"
          error={portNumber === null ? 'Enter a port from 1 to 65535' : null}
        >
          <TextInput
            aria-label="Port"
            type="number"
            inputMode="numeric"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
        </Field>
        <Field label="Username">
          <TextInput
            aria-label="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="me@example.com"
          />
        </Field>
        <Field label="App password">
          <TextInput
            aria-label="App password"
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </Field>
        <Field label="Folder">
          <TextInput
            aria-label="Folder"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
          />
        </Field>
        <Button
          className="w-full"
          busy={busy}
          disabled={!valid || busy}
          onClick={submit}
        >
          Add mailbox
        </Button>
      </PendingFieldset>
    </Sheet>
  );
}
