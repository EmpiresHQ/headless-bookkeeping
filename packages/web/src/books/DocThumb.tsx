import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { FileImage } from 'lucide-react';
import { fetchDocumentPreviewObjectUrl } from '../api';

/** Archive-row thumbnail: bearer-only /preview bytes → blob URL, revoked on
 *  unmount (same choreography as inbox/DocPreviewRow — StrictMode-safe).
 *
 *  `className` and `fallback` default to the original appearance, so
 *  existing callers (DocumentsSegment.tsx) need no change. `fallback`, when
 *  provided, replaces the built-in FileImage glyph when there is no preview
 *  (e.g. the inbox triage rows swap in their own reason glyph). */
export function DocThumb({
  id,
  className = 'h-12 w-9 rounded-md border border-line',
  fallback,
}: {
  id: number;
  className?: string;
  fallback?: ReactNode;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;
    fetchDocumentPreviewObjectUrl(id)
      .then((url) => {
        if (revoked) {
          URL.revokeObjectURL(url);
          return;
        }
        objectUrl = url;
        setSrc(url);
      })
      .catch(() => undefined); // no preview → fallback glyph
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id]);

  if (src !== null) {
    return <img src={src} alt="" className={`${className} object-cover`} />;
  }

  if (fallback !== undefined) {
    return <>{fallback}</>;
  }

  return (
    <span
      aria-hidden
      className="flex h-12 w-9 items-center justify-center rounded-md bg-line text-base"
    >
      <FileImage className="h-4 w-4 text-ink-3" aria-hidden />
    </span>
  );
}
