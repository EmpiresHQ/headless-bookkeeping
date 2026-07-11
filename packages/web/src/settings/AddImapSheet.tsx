import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  createMailboxConnector,
  type MailboxChannel,
  type MailboxProvider,
} from '../api';
import { invalidateMailbox } from '../queries/settings';
import { Button } from '../ui/Button';
import { Field, SelectInput, TextInput } from '../ui/Form';
import { Sheet } from '../ui/Sheet';
import { toastErr, toastOk } from '../ui/toast';

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
  const [busy, setBusy] = useState(false);
  const [channel, setChannel] = useState<MailboxChannel>('email_sync');
  const [provider, setProvider] = useState<MailboxProvider>('imap');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('993');
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  const [folder, setFolder] = useState('INBOX');

  const valid =
    host.trim() !== '' && username.trim() !== '' && secret.length > 0;

  const submit = async () => {
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
      toastOk(`Mailbox added — ${username.trim()}`);
      onClose();
      void invalidateMailbox(qc);
    } catch (e) {
      // Includes the server's MAILBOX_SECRET_KEY guidance verbatim.
      toastErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && !busy && onClose()}
      title="Add IMAP mailbox"
    >
      <div className="space-y-4 px-6 pb-2">
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
        <Field label="Port">
          <TextInput
            aria-label="Port"
            type="number"
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
          onClick={() => void submit()}
        >
          Add mailbox
        </Button>
      </div>
    </Sheet>
  );
}
