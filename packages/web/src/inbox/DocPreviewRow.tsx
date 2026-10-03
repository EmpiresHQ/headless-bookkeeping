import { useState } from 'react';
import { FileImage } from 'lucide-react';
import { ListGroup, ListRow } from '../ui/List';
import {
  DocumentPreviewLightbox,
  usePreviewObjectUrl,
  type PreviewState,
} from './DocumentPreviewLightbox';
import { useOpenOriginal } from './useOpenOriginal';

/**
 * Document preview row (asset §2): thumb + full-screen lightbox. The /preview
 * endpoint is Bearer-only, so the bytes are fetched into a blob: URL and
 * revoked on unmount (see usePreviewObjectUrl). The row always opens the
 * preview, whatever the thumbnail's state — the lightbox says what it has.
 */
export function DocPreviewRow({
  documentId,
  subtitle = 'Tap to preview',
}: {
  documentId: number;
  subtitle?: string;
}) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  // The document whose lightbox has been opened — drives the lazy lg fetch
  // (fetch once, keep the blob across reopens/closes). Per document: when
  // the row moves on to the next document (queue advance, issue #270) the
  // old lg is released and the new one waits for its own first open — or
  // loads at once if the preview is open right then.
  const [openedFor, setOpenedFor] = useState<number | null>(null);

  const thumb = usePreviewObjectUrl(documentId);
  // The sharp lg variant is only fetched once the lightbox is first opened; the
  // thumb stays visible as a qualified placeholder until this swaps in.
  const lg = usePreviewObjectUrl(documentId, {
    size: 'lg',
    active: lightboxOpen || openedFor === documentId,
  });
  // Open original belongs to this document's open preview (issue #272).
  const original = useOpenOriginal(documentId, lightboxOpen);

  return (
    <>
      <ListGroup label="Document">
        <ListRow
          onClick={() => {
            setLightboxOpen(true);
            setOpenedFor(documentId);
          }}
          leading={
            thumb.status === 'ready' ? (
              <img
                key={thumb.src}
                src={thumb.src}
                alt="Document preview"
                onError={() => thumb.reportBroken(thumb.src)}
                className="h-12 w-9 rounded-md border border-line object-cover"
              />
            ) : (
              <span
                aria-label={thumbLabel(thumb)}
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
      {/* Always mounted, driven by `open`: the close edge returns focus to
          the row (issue #269). */}
      <DocumentPreviewLightbox
        open={lightboxOpen}
        thumb={thumb}
        lg={lg}
        onClose={() => setLightboxOpen(false)}
        original={original}
      />
    </>
  );
}

/** The placeholder's name: loading is not "no preview" (issue #270). */
function thumbLabel(thumb: PreviewState): string {
  if (thumb.status === 'unavailable') return 'no preview';
  if (thumb.status === 'error') return 'preview failed to load';
  return 'loading preview';
}
