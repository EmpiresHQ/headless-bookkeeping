import { useEffect, useState } from 'react';
import { FileImage } from 'lucide-react';
import { fetchDocumentPreviewObjectUrl } from '../api';

/** Archive-row thumbnail: bearer-only /preview bytes → blob URL, revoked on
 *  unmount (same choreography as inbox/DocPreviewRow — StrictMode-safe). */
export function DocThumb({ id }: { id: number }) {
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
      <FileImage className="h-4 w-4 text-ink-3" aria-hidden />
    </span>
  );
}
