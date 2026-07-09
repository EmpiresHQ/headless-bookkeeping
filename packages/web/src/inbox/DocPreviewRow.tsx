import { useEffect, useState } from 'react';
import { fetchDocumentPreviewObjectUrl, openSignedDocument } from '../api';
import { ListGroup, ListRow } from '../ui/List';

/**
 * Document preview row (asset §2): thumb + "tap to open". The /preview
 * endpoint is Bearer-only, so the bytes are fetched into a blob: URL and
 * revoked on unmount (same choreography as legacy DocumentThumb, restyled);
 * the file opens via a signed token-free URL inside the click gesture.
 */
export function DocPreviewRow({
  documentId,
  subtitle = 'Tap to open the file',
}: {
  documentId: number;
  subtitle?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;
    fetchDocumentPreviewObjectUrl(documentId)
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
  }, [documentId]);

  return (
    <ListGroup label="Document">
      <ListRow
        onClick={() => void openSignedDocument(documentId)}
        leading={
          src !== null ? (
            <img
              src={src}
              alt="Document preview"
              className="h-12 w-9 rounded-md border border-line object-cover"
            />
          ) : (
            <span
              aria-label="no preview"
              className="flex h-12 w-9 items-center justify-center rounded-md bg-line text-base"
            >
              📄
            </span>
          )
        }
        title="Source document"
        subtitle={subtitle}
      />
    </ListGroup>
  );
}
