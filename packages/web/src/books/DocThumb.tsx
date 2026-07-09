import { useEffect, useState } from 'react';
import { fetchDocumentPreviewObjectUrl } from '../api';

/** Archive-row thumbnail: bearer-only /preview bytes → blob URL, revoked on
 *  unmount (same choreography as inbox/DocPreviewRow — StrictMode-safe).
 *  Rows without a preview (preview_path null) never fetch — the legacy
 *  component gated on it, and firing an authenticated /preview request for
 *  every archive row is wasted work when there is nothing to show. */
export function DocThumb({
  id,
  hasPreview,
}: {
  id: number;
  hasPreview: boolean;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!hasPreview) return;
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
  }, [id, hasPreview]);

  return src !== null ? (
    <img
      src={src}
      alt=""
      className="h-12 w-9 rounded-md border border-line object-cover"
    />
  ) : (
    <span
      aria-hidden
      className="flex h-12 w-9 items-center justify-center rounded-md bg-line text-base"
    >
      📄
    </span>
  );
}
