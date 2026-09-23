import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ExternalLink, FileImage, X } from 'lucide-react';
import { fetchDocumentPreviewObjectUrl } from '../api';
import { useFocusReturn } from '../lib/focusReturn';
import { useModalLayer } from '../lib/modalLayers';

/**
 * Fetch a /preview blob URL for a document into an object URL, revoked on
 * unmount / id change (StrictMode-safe — same choreography the thumb and
 * lightbox have always used). The Bearer-only endpoint is why the bytes are
 * pulled into a `blob:` URL rather than pointed at directly.
 *
 * `size: 'lg'` asks for the sharp variant; `active: false` defers the fetch
 * until the caller flips it on (e.g. the lg fetch only fires once a lightbox
 * is actually opened).
 */
export function usePreviewObjectUrl(
  id: number,
  { size, active = true }: { size?: 'lg'; active?: boolean } = {},
): string | null {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let revoked = false;
    let objectUrl: string | null = null;
    // Preserve the exact call shape both endpoints expect: the thumb fetch is
    // a bare id (no opts), the lg fetch passes `{ size: 'lg' }`.
    const request = size
      ? fetchDocumentPreviewObjectUrl(id, { size })
      : fetchDocumentPreviewObjectUrl(id);
    request
      .then((url) => {
        if (revoked) {
          URL.revokeObjectURL(url);
          return;
        }
        objectUrl = url;
        setSrc(url);
      })
      .catch(() => undefined); // no preview → caller falls back
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, size, active]);

  return src;
}

/**
 * Full-screen document preview. The image fills the viewport (object-contain,
 * so it scales up to the edges without cropping); the close and "open original"
 * controls float over a translucent scrim. Clicking the backdrop closes;
 * clicking the image itself or the toolbar does not. Escape closes.
 *
 * A real modal (issue #269) on Radix Dialog, the primitive under Sheet and
 * ConfirmDialog: focus is trapped inside (Tab wraps), the rest of the app is
 * aria-hidden, unclickable and not scrollable while it is open, and Escape
 * closes only the top layer. Callers keep it MOUNTED and drive `open`, so the
 * close edge is seen and focus returns to the opener (lib/focusReturn).
 */
export function DocumentPreviewLightbox({
  open,
  src,
  onClose,
  onOpenOriginal,
}: {
  open: boolean;
  src: string | null;
  onClose: () => void;
  onOpenOriginal: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // A modal layer while open (issue #267): Back closes the preview, not
  // the sheet or route underneath.
  useModalLayer(
    open,
    () => {
      onClose();
      return true;
    },
    ref,
  );
  // Focus (issue #268/#269): starts on Close — predictable, never an
  // editable field — and returns to the opener after close, unless focus
  // moved on, a newer layer is on top or the route changed.
  const focus = useFocusReturn({
    open,
    contentRef: ref,
    initialFocus: () => closeRef.current,
  });

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        {/* The scrim. Radix puts the scroll lock on the Overlay (content
            stays scrollable as its shard), so it must be rendered even
            though Content covers the viewport above it. */}
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/90" />
        <Dialog.Content
          ref={ref}
          // Accurate now that the background is really isolated (Radix
          // omits it by default; the preview has always declared it).
          aria-modal="true"
          aria-describedby={undefined}
          onOpenAutoFocus={focus.onOpenAutoFocus}
          onCloseAutoFocus={focus.onCloseAutoFocus}
          className="fixed inset-0 z-50 flex flex-col outline-none"
          onClick={onClose}
        >
          <Dialog.Title className="sr-only">Document preview</Dialog.Title>
          <div
            className="flex items-center justify-end gap-2 px-3 py-2.5"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={onOpenOriginal}
              className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-[14px] font-semibold text-white hover:bg-white/20"
            >
              <ExternalLink className="h-4 w-4" aria-hidden />
              Open original
            </button>
            <button
              type="button"
              ref={closeRef}
              aria-label="Close preview"
              className="flex h-10 w-10 items-center justify-center rounded-lg text-white hover:bg-white/10"
              onClick={onClose}
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
          </div>
          <div className="flex flex-1 items-center justify-center overflow-auto p-3">
            {src !== null ? (
              <img
                src={src}
                alt="Document preview"
                className="max-h-full max-w-full object-contain"
                onClick={(event) => event.stopPropagation()}
              />
            ) : (
              <div className="flex flex-col items-center gap-2 text-white/70">
                <FileImage className="h-8 w-8" aria-hidden />
                <p className="text-[13px]">No preview available</p>
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
