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
 * Drops into a `ListRow`'s `leading` slot the same way {@link DocThumb} does.
 * A navigating `ListRow` keeps `leading` outside its `<Link>` and stretches the
 * link over the row, so when a preview exists the thumb is a `<button>` raised
 * above that overlay (`relative z-10`) and neither it nor the (portaled)
 * lightbox is a descendant of the link: closing the preview can't bubble into a navigation.
 * When there is no preview we render the plain `fallback` glyph with no
 * button, so a tap there lands on the stretched link and navigates with the
 * rest of the row.
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

  // Always mounted, driven by `open` (portaled to <body>, so never in the
  // row's link): the close edge returns focus to the thumb (issue #269). It
  // stays mounted even if the thumb gives way to the fallback while open, so
  // the modal still closes through its own lifecycle.
  const lightbox = (
    <DocumentPreviewLightbox
      open={open}
      src={lgSrc ?? src}
      onClose={() => setOpen(false)}
      onOpenOriginal={() => void openSignedDocument(id)}
    />
  );

  if (src === null) {
    return (
      <>
        {fallback !== undefined ? (
          fallback
        ) : (
          <span
            aria-hidden
            className="flex h-12 w-9 items-center justify-center rounded-md bg-line text-base"
          >
            <FileImage className="h-4 w-4 text-ink-3" aria-hidden />
          </span>
        )}
        {lightbox}
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        aria-label="Open document preview"
        className="relative z-10 block"
        onClick={() => setOpen(true)}
      >
        <img src={src} alt="" className={`${className} object-cover`} />
      </button>
      {lightbox}
    </>
  );
}
