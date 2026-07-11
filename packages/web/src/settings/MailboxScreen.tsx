import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  deleteMailboxConnector,
  startMailboxOAuth,
  syncMailboxConnector,
  type MailboxConnector,
} from '../api';
import { useSheet } from '../lib/useSheet';
import {
  invalidateMailbox,
  useAdminSettings,
  useMailboxConnectors,
} from '../queries/settings';
import { ScreenHeader } from '../shell/Headers';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { GroupLabel, ListGroup } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { toastErr, toastOk } from '../ui/toast';
import { AddImapSheet } from './AddImapSheet';
import { SettingField } from './SettingField';

const STATUS_TONE: Record<MailboxConnector['status'], 'ok' | 'warn' | 'err'> = {
  connected: 'ok',
  disconnected: 'warn',
  auth_failed: 'err',
  error: 'err',
};

const OAUTH_DEFS = [
  { key: 'google_oauth_client_id', label: 'Google client id' },
  {
    key: 'google_oauth_client_secret',
    label: 'Google client secret',
    secret: true,
  },
  { key: 'microsoft_oauth_client_id', label: 'Microsoft client id' },
  {
    key: 'microsoft_oauth_client_secret',
    label: 'Microsoft client secret',
    secret: true,
  },
];

const lastSynced = (ts: number | null): string =>
  ts === null
    ? 'never synced'
    : `last synced ${new Date(ts * 1000).toLocaleString()}`;

/** /settings/mailbox — connectors with the truth visible (status + last
 *  error, asset §9+), sync/remove, IMAP sheet, BYO OAuth keys, and the
 *  rescued OAuth-return banner (Reality #9). */
export function MailboxScreen() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const connectorsQ = useMailboxConnectors();
  const settingsQ = useAdminSettings();
  const imap = useSheet();
  const [removeTarget, setRemoveTarget] = useState<MailboxConnector | null>(
    null,
  );
  const [removing, setRemoving] = useState(false);
  const [syncing, setSyncing] = useState<number | null>(null);

  // OAuth round-trip result (server callback → /?mailbox=… → Task 12 redirect
  // → here). Surface once, then strip so refresh doesn't replay the banner.
  // The toast is deferred a tick: on a cold app load (Root mounts
  // AppLayout — and this screen inside it — BEFORE AppToaster, same order
  // as this file's own tests) an effect firing synchronously on THIS
  // mount would publish before sonner's <Toaster/> has subscribed, and the
  // toast is silently dropped (sonner does not replay history to new
  // subscribers). setTimeout(0) runs after the whole commit's effects.
  useEffect(() => {
    const connected = params.get('mailbox') === 'connected';
    const err = params.get('mailbox_error');
    if (!connected && err === null) return;
    const t = setTimeout(() => {
      if (connected) toastOk('Mailbox connected');
      if (err !== null) toastErr(err);
    }, 0);
    const p = new URLSearchParams(params);
    p.delete('mailbox');
    p.delete('mailbox_error');
    setParams(p, { replace: true });
    return () => clearTimeout(t);
  }, []);

  const sync = async (id: number) => {
    setSyncing(id);
    try {
      await syncMailboxConnector(id);
      toastOk('Sync finished');
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(null);
      void invalidateMailbox(qc);
    }
  };

  const remove = async () => {
    if (removeTarget === null) return;
    setRemoving(true);
    try {
      await deleteMailboxConnector(removeTarget.id);
      toastOk(`Removed — ${removeTarget.username}`);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoving(false);
      setRemoveTarget(null);
      void invalidateMailbox(qc);
    }
  };

  const connect = async (provider: 'gmail' | 'outlook') => {
    try {
      const { url } = await startMailboxOAuth({
        provider,
        channel: 'email_sync',
      });
      window.location.assign(url);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title="Mail intake" backTo="/settings" />
      <p className="mx-6 mb-3 text-[12.5px] text-ink-2">
        Connected mailboxes are harvested for invoice attachments straight into
        the Inbox queue. Credentials are encrypted at rest; access is read-only.
      </p>

      {connectorsQ.isPending ? (
        <SkeletonRows count={2} />
      ) : connectorsQ.isError ? (
        <LoadError
          message={
            connectorsQ.error instanceof Error
              ? connectorsQ.error.message
              : 'Failed to load connectors'
          }
          onRetry={() => void connectorsQ.refetch()}
        />
      ) : connectorsQ.data.length === 0 ? (
        <EmptyState
          icon="📮"
          title="No mailboxes connected"
          hint="Connect Gmail/Outlook below, or add any IMAP mailbox with an app password."
        />
      ) : (
        <ListGroup>
          {connectorsQ.data.map((c) => (
            <div
              key={c.id}
              className="flex items-start justify-between gap-3 border-b border-line px-3.5 py-2.5 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-semibold">
                  {c.username}
                </p>
                <p className="text-[12px] text-ink-2">
                  {c.channel} · {c.provider} · {c.auth_mode} ·{' '}
                  {lastSynced(c.last_synced_at)}
                </p>
                {c.last_error !== null && (
                  <p className="mt-0.5 text-[12px] text-err">{c.last_error}</p>
                )}
              </div>
              <div className="flex flex-none flex-col items-end gap-1.5">
                <Chip tone={STATUS_TONE[c.status]}>
                  {c.status.replace('_', ' ')}
                </Chip>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    busy={syncing === c.id}
                    disabled={syncing !== null}
                    onClick={() => void sync(c.id)}
                    aria-label={`Sync ${c.username}`}
                  >
                    Sync
                  </Button>
                  <Button
                    variant="ghost"
                    className="text-err"
                    onClick={() => setRemoveTarget(c)}
                    aria-label={`Remove ${c.username}`}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </ListGroup>
      )}
      <p className="mx-6 -mt-2 mb-3.5 text-[12px] text-ink-2">
        Initial fetch depth is server-configured (mailbox_initial_fetch_count is
        not operator-settable over the API).
      </p>

      <div className="mx-3.5 mb-3.5 flex flex-wrap gap-2">
        <Button onClick={() => void connect('gmail')}>Connect Gmail</Button>
        <Button onClick={() => void connect('outlook')}>Connect Outlook</Button>
        <Button variant="secondary" onClick={() => imap.open()}>
          Add IMAP mailbox…
        </Button>
      </div>

      <GroupLabel>Your OAuth app (required for Gmail/Outlook)</GroupLabel>
      <div className="mx-3.5 mb-3.5 space-y-4 rounded-2xl bg-surface p-4">
        <p className="text-[12px] text-ink-2">
          Connecting Gmail/Outlook uses your own OAuth app. Set its redirect URI
          to{' '}
          <code className="font-mono">
            {'{public_api_url}'}/api/mailbox/oauth/callback
          </code>{' '}
          in the provider console, then paste the client id/secret here.
        </p>
        {OAUTH_DEFS.map((def) => (
          <SettingField
            key={def.key}
            def={def}
            current={settingsQ.data?.[def.key] ?? ''}
          />
        ))}
      </div>

      {imap.epoch > 0 && (
        <AddImapSheet
          key={imap.epoch}
          open={imap.isOpen}
          onClose={imap.close}
        />
      )}
      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(o) => !removing && !o && setRemoveTarget(null)}
        title="Remove this mailbox?"
        body={
          removeTarget !== null
            ? `${removeTarget.username} stops being harvested. Documents already in the queue stay.`
            : ''
        }
        confirmLabel="Remove mailbox"
        destructive
        busy={removing}
        onConfirm={() => void remove()}
      />
    </div>
  );
}
