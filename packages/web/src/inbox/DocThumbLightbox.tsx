import type { ReactNode } from 'react';
import { useState } from 'react';
import { FileImage } from 'lucide-react';
import { openSignedDocument } from '../api';
import {
  DocumentPreviewLightbox,
  usePreviewObjectUrl,
} from './DocumentPreviewLightbox';

/**
 * Clickable document thumbnail that opens the full-screen preview lightbox.
 *
 * Drops into a `ListRow`'s `leading` slot the same way {@link DocThumb} does,
 * but the row itself is usually a navigating `<Link>`, so when a preview
 * exists the thumb is a `<button>` that stops the click from bubbling to the
 * row (preventDefault + stopPropagation) and opens the lightbox instead. When
 * there is no preview to show we render the plain `fallback` glyph with no
 * button, so a tap there just navigates with the rest of the row.
 */
export function DocThumbLightbox({
  id,
  className = 'h-12 w-9 rounded-md border border-line',
  fallback,
}: {
  id: number;
  className?: string;
  fallback?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const src = usePreviewObjectUrl(id);
  // The sharp lg variant is only fetched once the lightbox is opened; the thumb
  // (`src`) is the instant placeholder until it swaps in.
  const lgSrc = usePreviewObjectUrl(id, { size: 'lg', active: open });

  if (src === null) {
    if (fallback !== undefined) return <>{fallback}</>;
    return (
      <span
        aria-hidden
        className="flex h-12 w-9 items-center justify-center rounded-md bg-line text-base"
      >
        <FileImage className="h-4 w-4 text-ink-3" aria-hidden />
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        aria-label="Open document preview"
        onClick={(event) => {
          // The thumb lives inside the row's <Link>; keep the click from
          // navigating so it opens the lightbox instead.
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
      >
        <img src={src} alt="" className={`${className} object-cover`} />
      </button>
      {open && (
        <DocumentPreviewLightbox
          src={lgSrc ?? src}
          onClose={() => setOpen(false)}
          onOpenOriginal={() => void openSignedDocument(id)}
        />
      )}
    </>
  );
}
