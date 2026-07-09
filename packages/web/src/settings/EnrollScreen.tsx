import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { createDeviceEnrollment, type DeviceEnrollment } from '../api';
import { useAdminSettings } from '../queries/settings';
import { ScreenHeader } from '../shell/Headers';
import { Button } from '../ui/Button';
import { SkeletonRows } from '../ui/Feedback';
import { GroupLabel } from '../ui/List';
import { SettingField } from './SettingField';

/**
 * /settings/enroll — mobile enrollment QR. The payload shape {v,api,enroll}
 * is the mobile-app contract (legacy EnrollView verbatim). The dominant
 * failure — unset public_api_url → server 500 (Reality #8) — renders
 * guidance WITH the fix inline: the public_api_url setting lives on this
 * screen (it IS the QR's base URL).
 * StrictMode note: dev double-mount mints two one-time tokens (legacy
 * parity) — only the rendered one is ever scanned; harmless.
 */
export function EnrollScreen() {
  const [qr, setQr] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<DeviceEnrollment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const settingsQ = useAdminSettings();

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setPending(true);
      setError(null);
      setQr(null);
      try {
        const e = await createDeviceEnrollment();
        if (cancelled) return;
        setEnrollment(e);
        const payload = JSON.stringify({
          v: 1,
          api: e.apiBaseUrl,
          enroll: e.enrollmentToken,
        });
        const dataUrl = await QRCode.toDataURL(payload);
        if (!cancelled) setQr(dataUrl);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setPending(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const unconfigured = error !== null && error.includes('Public API URL');

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title="Mobile device" backTo="/settings" />
      {pending && <SkeletonRows count={2} />}
      {!pending && error !== null && (
        <div className="mx-3.5 mb-3.5 rounded-2xl bg-warn-bg p-4">
          <p className="text-[13.5px] font-bold text-warn">
            {unconfigured
              ? 'The QR cannot be generated yet'
              : 'Enrollment failed'}
          </p>
          <p className="mt-1 text-[12.5px] leading-snug text-warn">
            {unconfigured
              ? 'The phone needs a public base URL to talk to. Set it below (https://…, or http://localhost for dev) and try again.'
              : error}
          </p>
          <Button
            variant="secondary"
            className="mt-3"
            onClick={() => setReloadKey((k) => k + 1)}
          >
            Try again
          </Button>
        </div>
      )}
      {!pending && qr !== null && (
        <div className="mx-3.5 mb-3.5 flex flex-col items-center gap-2 rounded-2xl bg-surface p-5">
          <img src={qr} alt="Enrollment QR code" width={256} height={256} />
          {enrollment !== null && (
            <p className="text-[12.5px] text-ink-2">
              Expires {new Date(enrollment.expiresAt).toLocaleTimeString()} —
              one-time use
            </p>
          )}
          <Button
            variant="secondary"
            onClick={() => setReloadKey((k) => k + 1)}
          >
            Regenerate
          </Button>
        </div>
      )}
      <GroupLabel>Public API URL</GroupLabel>
      <div className="mx-3.5 mb-3.5 rounded-2xl bg-surface p-4">
        <SettingField
          def={{
            key: 'public_api_url',
            label: 'Public API URL',
            placeholder: 'https://api.example.com',
            hint: 'Embedded in the QR — the address the phone will call. https:// required (http://localhost allowed for dev).',
          }}
          current={settingsQ.data?.['public_api_url'] ?? ''}
        />
      </div>
    </div>
  );
}
