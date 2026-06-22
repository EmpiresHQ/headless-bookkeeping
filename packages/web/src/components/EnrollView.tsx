import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { createDeviceEnrollment, type DeviceEnrollment } from '../api';

export function EnrollView() {
  const [qr, setQr] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<DeviceEnrollment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
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
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return (
    <div className="p-4 space-y-4">
      <h2 className="font-semibold">Enroll a mobile device</h2>
      {error && <p className="text-red-600">{error}</p>}
      {qr && <img src={qr} alt="Enrollment QR code" width={256} height={256} />}
      {enrollment && (
        <p className="text-sm text-gray-600">
          Expires at {new Date(enrollment.expiresAt).toLocaleTimeString()}
        </p>
      )}
      <button
        className="rounded bg-gray-800 px-3 py-1 text-white"
        onClick={() => setReloadKey((k) => k + 1)}
      >
        Regenerate
      </button>
    </div>
  );
}
