import { useEffect, useState } from 'react';
import { ExternalLink, FileImage, X } from 'lucide-react';
import { fetchDocumentPreviewObjectUrl, openSignedDocument } from '../api';
import { Button } from '../ui/Button';
import { ListGroup, ListRow } from '../ui/List';

function DocumentPreviewLightbox({
  src,
  onClose,
  onOpenOriginal,
}: {
  src: string | null;
  onClose: () => void;
  onOpenOriginal: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="document-preview-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 px-4 py-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-3xl flex-col rounded-lg bg-surface"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
          <h2 id="document-preview-title" className="text-[15px] font-semibold">
            Document preview
          </h2>
          <button
            type="button"
            aria-label="Close preview"
            className="flex h-10 w-10 items-center justify-center rounded-lg text-ink-2"
            onClick={onClose}
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <div className="flex min-h-64 flex-1 items-center justify-center overflow-auto bg-bg p-3">
          {src !== null ? (
            <img
              src={src}
              alt="Document preview"
              className="max-h-[70dvh] max-w-full rounded-md border border-line object-contain"
            />
          ) : (
            <div className="flex flex-col items-center gap-2 text-ink-2">
              <FileImage className="h-8 w-8" aria-hidden />
              <p className="text-[13px]">No preview available</p>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-3.5 py-2.5">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button onClick={onOpenOriginal}>
            <span className="inline-flex items-center gap-2">
              <ExternalLink className="h-4 w-4" aria-hidden />
              Open original
            </span>
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Document preview row (asset §2): thumb + lightbox. The /preview
 * endpoint is Bearer-only, so the bytes are fetched into a blob: URL and
 * revoked on unmount (same choreography as the deleted legacy thumb component).
 */
export function DocPreviewRow({
  documentId,
  subtitle = 'Tap to preview',
}: {
  documentId: number;
  subtitle?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  // Sticks at true once the lightbox has been opened at least once — drives
  // the lazy lg fetch below (fetch once, keep the blob across reopens/closes).
  const [hasOpenedLightbox, setHasOpenedLightbox] = useState(false);
  const [lgSrc, setLgSrc] = useState<string | null>(null);

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

  // Lazily fetch the sharp lg variant once the lightbox is first opened — the
  // thumb (`src`) stays visible as an instant placeholder until this swaps in.
  useEffect(() => {
    if (!hasOpenedLightbox) return;
    let revoked = false;
    let objectUrl: string | null = null;
    fetchDocumentPreviewObjectUrl(documentId, { size: 'lg' })
      .then((url) => {
        if (revoked) {
          URL.revokeObjectURL(url);
          return;
        }
        objectUrl = url;
        setLgSrc(url);
      })
      .catch(() => undefined); // lg fetch failed → stay on the thumb
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [hasOpenedLightbox, documentId]);

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
