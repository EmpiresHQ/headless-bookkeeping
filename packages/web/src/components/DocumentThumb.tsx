import { useEffect, useState } from 'react';
import { fetchDocumentPreviewObjectUrl, openSignedDocument } from '../api';

interface Props {
  id: number;
  /** null = known-absent → skip the request, show fallback immediately.
   *  undefined = unknown → request preview, fall back on error. */
  preview_path?: string | null;
}

export function DocumentThumb({ id, preview_path }: Props) {
  const [errored, setErrored] = useState(preview_path === null);
  // The /preview endpoint is Bearer-only, so an <img src> cannot load it.
  // Fetch the bytes (token attached) into a blob: URL and revoke it on unmount.
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (preview_path === null) return; // known-absent → fallback, no request
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
      .catch(() => setErrored(true));
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, preview_path]);

  // The file endpoint is Bearer-only too. Mint a signed, token-free URL on
  // click and open it (see openSignedDocument).
  function openFile(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    void openSignedDocument(id);
  }

  return (
    <a href={`/api/documents/${id}/file`} onClick={openFile} title="Open file">
      {errored || !src ? (
        <span
          aria-label="no preview"
          className="inline-flex items-center justify-center w-10 h-10 bg-gray-100 rounded text-gray-400 text-xs"
        >
          📄
        </span>
      ) : (
        <img
          src={src}
          alt="preview"
          aria-label="preview"
          width={48}
          height={48}
          className="w-10 h-10 object-cover rounded border border-gray-200"
          onError={() => setErrored(true)}
        />
      )}
    </a>
  );
}
