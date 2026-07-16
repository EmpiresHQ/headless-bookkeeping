import { useState } from 'react';
import { FileImage } from 'lucide-react';
import { openSignedDocument } from '../api';
import { ListGroup, ListRow } from '../ui/List';
import {
  DocumentPreviewLightbox,
  usePreviewObjectUrl,
} from './DocumentPreviewLightbox';

/**
 * Document preview row (asset §2): thumb + full-screen lightbox. The /preview
 * endpoint is Bearer-only, so the bytes are fetched into a blob: URL and
 * revoked on unmount (see usePreviewObjectUrl).
 */
export function DocPreviewRow({
  documentId,
  subtitle = 'Tap to preview',
}: {
  documentId: number;
  subtitle?: string;
}) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  // Sticks at true once the lightbox has been opened at least once — drives
  // the lazy lg fetch (fetch once, keep the blob across reopens/closes).
  const [hasOpenedLightbox, setHasOpenedLightbox] = useState(false);

  const src = usePreviewObjectUrl(documentId);
  // The sharp lg variant is only fetched once the lightbox is first opened; the
  // thumb (`src`) stays visible as an instant placeholder until this swaps in.
  const lgSrc = usePreviewObjectUrl(documentId, {
    size: 'lg',
    active: hasOpenedLightbox,
  });

  return (
    <>
      <ListGroup label="Document">
        <ListRow
          onClick={() => {
            setLightboxOpen(true);
            setHasOpenedLightbox(true);
          }}
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
                <FileImage className="h-4 w-4 text-ink-3" aria-hidden />
              </span>
            )
          }
          title="Source document"
          subtitle={subtitle}
        />
      </ListGroup>
      {lightboxOpen && (
        <DocumentPreviewLightbox
          src={lgSrc ?? src}
          onClose={() => setLightboxOpen(false)}
          onOpenOriginal={() => void openSignedDocument(documentId)}
        />
      )}
    </>
  );
}
