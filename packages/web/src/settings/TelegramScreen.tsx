import { useAdminSettings } from '../queries/settings';
import { ScreenHeader } from '../shell/Headers';
import { SkeletonRows } from '../ui/Feedback';
import { GroupLabel } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { SettingField, type SettingDef } from './SettingField';

const TELEGRAM_DEFS: SettingDef[] = [
  {
    key: 'telegram_bot_token',
    label: 'Bot token',
    placeholder: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
    secret: true,
  },
  {
    key: 'telegram_webhook_secret',
    label: 'Webhook secret',
    placeholder: 'telegram-webhook-secret',
    secret: true,
  },
  {
    key: 'telegram_allowlist',
    label: 'Allowlist chat ids',
    placeholder: '123456789, 987654321',
    multiline: true,
  },
];

const APPROVER_DEFS: SettingDef[] = [
  {
    key: 'approvers',
    label: 'Approvers',
    placeholder: '123456789, boss@example.com',
    hint: 'Comma-separated Telegram user IDs and/or email addresses — who gets approval prompts',
  },
  {
    key: 'email_whitelist',
    label: 'Email whitelist',
    placeholder: 'boss@example.com, cfo@example.com',
    multiline: true,
    hint: 'Senders allowed to converse/command over email',
  },
];

/** /settings/telegram — Telegram config is exactly three settings keys plus
 *  a webhook the server registers at boot (Reality #10); approvers and the
 *  email whitelist are the channel-adjacent registry keys the legacy UI
 *  never surfaced (Reality #2). */
export function TelegramScreen() {
  const settingsQ = useAdminSettings();
  if (settingsQ.isPending) {
    return (
      <Frame>
        <SkeletonRows count={3} />
      </Frame>
    );
  }
  if (settingsQ.isError) {
    return (
      <Frame>
        <LoadError
          message={
            settingsQ.error instanceof Error
              ? settingsQ.error.message
              : 'Failed to load settings'
          }
          onRetry={() => void settingsQ.refetch()}
        />
      </Frame>
    );
  }
  const map = settingsQ.data;
  const group = (defs: SettingDef[]) => (
    <div className="mx-3.5 mb-3.5 space-y-4 rounded-2xl bg-surface p-4">
      {defs.map((def) => (
        <SettingField key={def.key} def={def} current={map[def.key] ?? ''} />
      ))}
    </div>
  );
  return (
    <Frame>
      <GroupLabel>Telegram bot</GroupLabel>
      {group(TELEGRAM_DEFS)}
      <p className="mx-6 -mt-2 mb-3.5 text-[12px] text-warn">
        Restart the app after changing these — the webhook registration reads
        the token and secret at boot.
      </p>
      <GroupLabel>Approvals & channels</GroupLabel>
      {group(APPROVER_DEFS)}
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title="Telegram & approvers" backTo="/settings" />
      {children}
    </div>
  );
}
