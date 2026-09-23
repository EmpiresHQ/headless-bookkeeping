import { useCallback, useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ExternalLink, FileImage, X } from 'lucide-react';
import { fetchDocumentPreviewObjectUrl } from '../api';
import { HttpError } from '../auth';
import { useFocusReturn } from '../lib/focusReturn';
import { useModalLayer } from '../lib/modalLayers';

/** Where one preview variant of one document stands (issue #270). A 404 is
 *  `unavailable` — this document has no preview, which says nothing about
 *  its original; every other failure is a retryable `error`. */
export type PreviewStatus =
  | { status: 'idle' }
  | { status: 'loading'; retrying: boolean }
  | { status: 'ready'; src: string }
  | { status: 'unavailable' }
  | { status: 'error' };

export type PreviewState = PreviewStatus & {
  /** From `error`/`unavailable` only (single flight): read this variant
   *  again — the preview GET, nothing else. */
  retry: () => void;
  /** The image of exactly `src` failed to decode — a retryable error. Any
   *  other URL (an earlier result, another document) is ignored. */
  reportBroken: (src: string) => void;
};

type Settled = Exclude<PreviewStatus, { status: 'idle' }>;

/**
 * Fetch a /preview blob URL for a document into an object URL, revoked when
 * its request's run ends (id/variant change, deactivation, retry, unmount).
 * The Bearer-only endpoint is why the bytes are pulled into a `blob:` URL
 * rather than pointed at directly.
 *
 * Every result is bound to the identity it was requested for (id + variant +
 * attempt): the first render after the id changes is already `loading`, so
 * an old document's (about to be revoked) URL is never shown for the new
 * one, and a late answer of an ended run is dropped (its URL revoked).
 *
 * `size: 'lg'` asks for the sharp variant; `active: false` defers the fetch
 * until the caller flips it on (e.g. the lg fetch only fires once a lightbox
 * is actually opened).
 */
export function usePreviewObjectUrl(
  id: number,
  { size, active = true }: { size?: 'lg'; active?: boolean } = {},
): PreviewState {
  // Every request identity gets a new generation, bumped during render on
  // ANY id / variant / activation change (and on Retry): a result is shown
  // only for the generation it was read for, so going A → B → A never
  // resurfaces A's earlier (revoked) URL, and neither does a reopen.
  const [identity, setIdentity] = useState({ id, size, active, gen: 0 });
  let gen = identity.gen;
  if (
    identity.id !== id ||
    identity.size !== size ||
    identity.active !== active
  ) {
    gen += 1;
    setIdentity({ id, size, active, gen });
  }
  const [entry, setEntry] = useState<{ gen: number; state: Settled } | null>(
    null,
  );

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    // Preserve the exact call shape both endpoints expect: the thumb fetch is
    // a bare id (no opts), the lg fetch passes `{ size: 'lg' }`.
    const request = size
      ? fetchDocumentPreviewObjectUrl(id, { size })
      : fetchDocumentPreviewObjectUrl(id);
    request.then(
      (url) => {
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        objectUrl = url;
        setEntry({ gen, state: { status: 'ready', src: url } });
      },
      (e: unknown) => {
        if (cancelled) return;
        setEntry({
          gen,
          state:
            e instanceof HttpError && e.status === 404
              ? { status: 'unavailable' }
              : { status: 'error' },
        });
      },
    );
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, size, active, gen]);

  let current: PreviewStatus;
  if (!active) current = { status: 'idle' };
  else if (entry?.gen === gen) current = entry.state;
  else current = { status: 'loading', retrying: false };

  // A 404 is retryable too: the server also answers it when a render
  // failed, which a later read can recover from.
  const failed = current.status === 'error' || current.status === 'unavailable';
  const retry = () => {
    if (!failed) return;
    setIdentity({ id, size, active, gen: gen + 1 });
    setEntry({ gen: gen + 1, state: { status: 'loading', retrying: true } });
  };
  const reportBroken = (src: string) => {
    setEntry((cur) =>
      cur !== null && cur.state.status === 'ready' && cur.state.src === src
        ? { gen: cur.gen, state: { status: 'error' } }
        : cur,
    );
  };

  return { ...current, retry, reportBroken };
}

/** What the lightbox shows for a document, from its two variants: the sharp
 *  lg image, else the thumb as a qualified placeholder, else a message. */
function previewView(thumb: PreviewState, lg: PreviewState) {
  if (lg.status === 'ready') {
    return { image: lg, note: '', canRetry: false, retrying: false };
  }
  const image = thumb.status === 'ready' ? thumb : null;
  const retrying = lg.status === 'loading' && lg.retrying;
  let note: string;
  if (lg.status === 'unavailable') {
    note = image
      ? 'Full-size preview isn’t available — showing a smaller one.'
      : 'No preview is available for this document. You can still try Open original.';
  } else if (lg.status === 'error') {
    note = image
      ? 'The full-size preview couldn’t be loaded — showing a smaller one.'
      : 'The preview couldn’t be loaded.';
  } else {
    note = image ? 'Loading full-size preview…' : 'Loading preview…';
  }
  const canRetry =
    lg.status === 'error' || lg.status === 'unavailable' || retrying;
  return { image, note, canRetry, retrying };
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
 *
 * Loading, "no preview" (404) and failure are told apart (issue #270): a
 * failure offers Retry — of the preview reads only — and Open original is
 * there in every state. A polite status line says what is shown; nothing is
 * announced while closed (the content is unmounted).
 */
export function DocumentPreviewLightbox({
  open,
  thumb,
  lg,
  onClose,
  onOpenOriginal,
}: {
  open: boolean;
  /** The document's thumbnail — a placeholder while lg is not ready. */
  thumb: PreviewState;
  /** The sharp variant, active while the preview is (or was) open. */
  lg: PreviewState;
  onClose: () => void;
  onOpenOriginal: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const view = previewView(thumb, lg);
  const image = view.image;
  // Retry leaves once its retry succeeds. If it held focus, hand focus to
  // Close before it is removed so it never drops out of the modal; nothing
  // else is focused as requests settle. (Not on close: the whole dialog
  // goes and focusReturn owns where focus lands.)
  const openRef = useRef(open);
  openRef.current = open;
  const retryNode = useRef<HTMLButtonElement | null>(null);
  const retryRef = useCallback((el: HTMLButtonElement | null) => {
    const prev = retryNode.current;
    retryNode.current = el;
    if (
      el === null &&
      openRef.current &&
      prev !== null &&
      document.activeElement === prev
    ) {
      closeRef.current?.focus();
    }
  }, []);
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
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3">
            {image !== null ? (
              // Keyed by URL: each <img> node shows one result, so an error
              // queued for an earlier src can only report that src.
              <img
                key={image.src}
                src={image.src}
                alt="Document preview"
                className="max-h-full max-w-full object-contain"
                onError={() => image.reportBroken(image.src)}
                onClick={(event) => event.stopPropagation()}
              />
            ) : (
              <FileImage className="h-8 w-8 text-white/70" aria-hidden />
            )}
          </div>
          <div
            className={`flex flex-col items-center gap-2 px-3 text-center text-white/80 ${
              view.note !== '' ? 'pb-4' : ''
            }`}
            onClick={(event) => {
              if (view.note !== '') event.stopPropagation();
            }}
          >
            <p role="status" className="text-[13px]">
              {view.note}
            </p>
            {view.canRetry && (
              <button
                type="button"
                ref={retryRef}
                aria-disabled={view.retrying || undefined}
                onClick={() => {
                  if (view.retrying) return;
                  lg.retry();
                  thumb.retry(); // no-op unless the thumb failed too
                }}
                className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-[14px] font-semibold text-white hover:bg-white/20 aria-disabled:opacity-60"
              >
                {view.retrying ? 'Retrying…' : 'Retry'}
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
