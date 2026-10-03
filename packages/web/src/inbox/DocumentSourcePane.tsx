import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileImage,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {
  PDFDocumentProxy,
  RenderTask,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  fetchDocumentFile,
  fetchDocumentPreviewBlob,
  type DocumentFile,
} from '../api';
import { HttpError } from '../auth';
import { Button } from '../ui/Button';
import { toastErr } from '../ui/toast';
import { loadPdfJs, pdfDocumentOptions } from './pdfjs';
import { READABLE } from '../ui/List';

/**
 * The source document, viewable INSIDE a verification form (issue #257):
 * the original file (every page), not the page-1 preview thumbnail.
 *
 * Deliberately NOT under the `inbox` query prefix: invalidateInbox (and
 * books/settings writes) invalidate `['inbox']`, which would refetch an
 * active source, swap the blob and reset the viewer's page/zoom mid-check.
 * The per-session QueryClient + per-document key mean a late result from a
 * closed/replaced form or an ended session never lands in another form.
 */
export const sourceKeys = {
  file: (id: number) => ['document-source', id, 'file'] as const,
  preview: (id: number) => ['document-source', id, 'preview-lg'] as const,
};

// Once loaded, the bytes never change under the viewer; a failure is retried
// only by the operator (explicit Retry), never silently.
const HOLD = {
  staleTime: Infinity,
  retry: false,
  refetchOnMount: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

/** Raster types every supported browser draws natively in an <img>. HEIC /
 *  TIFF are stored too, but only the server can render them (page 1). */
const INLINE_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
]);

const ZOOMS = [1, 1.5, 2, 3] as const;
/** Canvas backing-store cap (iOS Safari refuses canvases much above ~16.7M
 *  pixels): a zoomed page lowers its output scale instead of failing. */
const MAX_CANVAS_PIXELS = 16_000_000;

/** The blob's media type without parameters (`; charset=…`). */
function mediaType(blob: Blob): string {
  return blob.type.split(';')[0].trim().toLowerCase();
}

function errorText(e: unknown, missing: string): string {
  if (e instanceof HttpError && e.status === 404) return missing;
  return e instanceof Error ? e.message : String(e);
}

/** An object URL for a blob, revoked when the blob changes or on unmount. */
export function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (blob === null) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

export function DocumentSourcePane({
  documentId,
  active,
}: {
  documentId: number;
  /** Fetch only while the owning form is open. */
  active: boolean;
}) {
  const fileQ = useQuery({
    queryKey: sourceKeys.file(documentId),
    queryFn: () => fetchDocumentFile(documentId),
    enabled: active,
    ...HOLD,
  });
  const file = fileQ.data ?? null;
  const url = useObjectUrl(file?.blob ?? null);

  let body: ReactNode;
  if (fileQ.isError && !fileQ.isFetching) {
    body = (
      <SourceMessage
        text={errorText(
          fileQ.error,
          'The source file is missing — it may have been replaced or deleted.',
        )}
        onRetry={() => void fileQ.refetch()}
      />
    );
  } else if (file === null || url === null) {
    body = <SourceMessage text="Loading the source document…" muted />;
  } else {
    const type = mediaType(file.blob);
    body =
      type === 'application/pdf' ? (
        <PdfViewer blob={file.blob} />
      ) : INLINE_IMAGE_TYPES.has(type) ? (
        <ImageViewer url={url} />
      ) : (
        <PreviewFallback documentId={documentId} type={type} />
      );
  }

  return (
    <section
      aria-label="Source document"
      className="flex h-full min-h-0 flex-col bg-surface"
    >
      {/* The filename keeps at least 12rem beside the actions; in a
          narrower pane the actions wrap onto their own line and the name
          takes the full header width (#275). */}
      <div className="flex flex-none flex-wrap items-center justify-end gap-x-2 border-b border-line px-3 py-1.5">
        <p
          className={`min-w-0 flex-[1_1_12rem] text-[12.5px] font-semibold text-ink-2 ${READABLE}`}
        >
          {file?.filename ?? 'Source document'}
        </p>
        {file !== null && url !== null && (
          <div className="flex flex-none items-center">
            <SourceActions file={file} url={url} documentId={documentId} />
          </div>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{body}</div>
    </section>
  );
}

/** Source-only actions: they never navigate this tab (a dirty form would be
 *  lost), so there is no current-tab fallback when a popup is blocked. */
function SourceActions({
  file,
  url,
  documentId,
}: {
  file: DocumentFile;
  url: string;
  documentId: number;
}) {
  // Only types the browser shows as inert media: an HTML/SVG/unknown blob
  // opened same-origin could run its own script, so those are Download-only.
  const type = mediaType(file.blob);
  const viewable = type === 'application/pdf' || INLINE_IMAGE_TYPES.has(type);
  const openInTab = () => {
    const tab = window.open(url, '_blank');
    if (tab === null) {
      toastErr('The browser blocked the new tab — use Download instead.');
      return;
    }
    tab.opener = null;
  };
  return (
    <>
      <a
        href={url}
        download={file.filename ?? `document-${documentId}`}
        className="flex min-h-9 items-center gap-1 rounded-lg px-2 text-[12.5px] font-semibold text-accent"
      >
        <Download className="size-4" aria-hidden /> Download
      </a>
      {viewable && (
        <button
          type="button"
          onClick={openInTab}
          className="flex min-h-9 items-center gap-1 rounded-lg px-2 text-[12.5px] font-semibold text-accent"
        >
          <ExternalLink className="size-4" aria-hidden /> New tab
        </button>
      )}
    </>
  );
}

function SourceMessage({
  text,
  muted = false,
  onRetry,
}: {
  text: string;
  muted?: boolean;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-5 text-center">
      <p
        role={muted ? undefined : 'alert'}
        className={`text-[13px] ${muted ? 'text-ink-2' : 'font-semibold text-err'}`}
      >
        {text}
      </p>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

const iconButton =
  'flex size-9 items-center justify-center rounded-lg text-ink-2 hover:bg-line disabled:opacity-40';

function ZoomControls({
  zoom,
  onZoom,
}: {
  zoom: number;
  onZoom: (i: number) => void;
}) {
  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        aria-label="Zoom out"
        disabled={zoom === 0}
        onClick={() => onZoom(zoom - 1)}
        className={iconButton}
      >
        <ZoomOut className="size-4" aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Fit width"
        onClick={() => onZoom(0)}
        className="min-h-9 min-w-12 rounded-lg px-1 text-[12px] font-semibold tabular-nums text-ink-2 hover:bg-line"
      >
        {Math.round(ZOOMS[zoom] * 100)}%
      </button>
      <button
        type="button"
        aria-label="Zoom in"
        disabled={zoom === ZOOMS.length - 1}
        onClick={() => onZoom(zoom + 1)}
        className={iconButton}
      >
        <ZoomIn className="size-4" aria-hidden />
      </button>
    </div>
  );
}

function Toolbar({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-none items-center justify-between gap-2 border-b border-line px-2 py-1">
      {children}
    </div>
  );
}

/** What a viewer reports once it settles: drawn, or an error shown. */
export type ViewerStatus = 'ready' | 'error';

/** A long image scrolls; zoom widens it past the pane (both axes scroll). */
export function ImageViewer({
  url,
  alt = 'Source document',
  failedText = 'This image could not be displayed — download the original to view it.',
  onStatus,
}: {
  url: string;
  alt?: string;
  /** Copy for an image the browser cannot draw — what to do instead
   *  depends on where the file is (the server's original vs. a local pick). */
  failedText?: string;
  onStatus?: (s: ViewerStatus) => void;
}) {
  const [zoom, setZoom] = useState(0);
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <SourceMessage text={failedText} />;
  }
  return (
    <>
      <Toolbar>
        <span />
        <ZoomControls zoom={zoom} onZoom={setZoom} />
      </Toolbar>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <img
          src={url}
          alt={alt}
          onLoad={() => onStatus?.('ready')}
          onError={() => {
            setFailed(true);
            onStatus?.('error');
          }}
          style={{ width: `${ZOOMS[zoom] * 100}%`, maxWidth: 'none' }}
          className="block h-auto"
        />
      </div>
    </>
  );
}

/** HEIC/TIFF/unknown: only the server can rasterise it — page 1, labelled. */
function PreviewFallback({
  documentId,
  type,
}: {
  documentId: number;
  type: string;
}) {
  const previewQ = useQuery({
    queryKey: sourceKeys.preview(documentId),
    queryFn: () => fetchDocumentPreviewBlob(documentId, { size: 'lg' }),
    ...HOLD,
  });
  const url = useObjectUrl(previewQ.data ?? null);
  const note = `This file type (${type || 'unknown'}) can't be shown in full here — download the original to see all of it.`;
  if (previewQ.isError && !previewQ.isFetching) {
    return previewQ.error instanceof HttpError &&
      previewQ.error.status === 404 ? (
      <SourceMessage text={note} />
    ) : (
      <SourceMessage
        text={errorText(previewQ.error, note)}
        onRetry={() => void previewQ.refetch()}
      />
    );
  }
  return (
    <>
      <p className="flex-none px-3 py-2 text-[12px] text-ink-2">
        First page only. {note}
      </p>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {url !== null ? (
          <img
            src={url}
            alt="Source document, first page"
            className="block h-auto w-full"
          />
        ) : (
          <div className="flex justify-center p-5 text-ink-3">
            <FileImage className="size-8" aria-hidden />
          </div>
        )}
      </div>
    </>
  );
}

type PdfState =
  | { status: 'loading' }
  | { status: 'ready'; doc: PDFDocumentProxy }
  | { status: 'error'; message: string; retry: boolean };

/** Whose PDF is shown: the stored original (the alternative is to download
 *  it) or a file the operator just chose on this device (the alternative is
 *  another file — there is no "original" to download). */
export type PdfSubject = 'source' | 'local';

function pdfLoadError(
  e: unknown,
  subject: PdfSubject,
): { message: string; retry: boolean } {
  const name = e instanceof Error ? e.name : '';
  if (subject === 'local') {
    if (name === 'PasswordException') {
      return {
        message:
          'This PDF is password-protected, so its pages can’t be checked here — and it may not be readable after upload either. Choose an unprotected copy or a photo of the document if you can.',
        retry: false,
      };
    }
    if (name === 'InvalidPDFException') {
      return {
        message:
          'This file could not be opened as a PDF — it may be damaged or not really a PDF. Choose another file (a PDF that opens, or a photo) to check it before uploading.',
        retry: false,
      };
    }
    return {
      message: `The PDF preview could not open this file: ${
        e instanceof Error ? e.message : String(e)
      }`,
      retry: true,
    };
  }
  if (name === 'PasswordException') {
    return {
      message:
        'This PDF is password-protected and can’t be shown here — download the original to open it.',
      retry: false,
    };
  }
  if (name === 'InvalidPDFException') {
    return {
      message:
        'This PDF is damaged or not a valid PDF, so it can’t be shown — download the original to check it.',
      retry: true,
    };
  }
  return {
    message: `The PDF viewer could not open this file: ${
      e instanceof Error ? e.message : String(e)
    }`,
    retry: true,
  };
}

/** Width of an element's content box, tracked across resizes/rotation.
 *  A callback ref: when the element is replaced (e.g. after an error and
 *  Retry) the observer moves to the new node instead of a detached one. */
function useContentWidth(): [(el: HTMLElement | null) => void, number] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (el === null) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const w =
        el.clientWidth -
        (parseFloat(cs.paddingLeft) || 0) -
        (parseFloat(cs.paddingRight) || 0);
      setWidth(Math.max(0, Math.floor(w)));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width];
}

/**
 * Every page of a PDF, one at a time on ONE canvas (bounded memory — no
 * eager canvas per page). Page and zoom live here; the pane stays mounted
 * while the form is shown, so they survive Form/Source toggles.
 *
 * The canvas is shown only once the CURRENT render generation finished
 * drawing: while page 5 renders, page 4's pixels are never on screen under
 * a "Page 5" label, and a failed render never leaves another page visible.
 */
export function PdfViewer({
  blob,
  subject = 'source',
  onStatus,
}: {
  blob: Blob;
  subject?: PdfSubject;
  /** Told when the first page is drawn, or the document failed to open. */
  onStatus?: (s: ViewerStatus) => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PdfState>({ status: 'loading' });
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(0);
  const [renderAttempt, setRenderAttempt] = useState(0);
  const [pageError, setPageError] = useState<string | null>(null);
  // Monotonic render generation. `drawn` names the generation whose pixels
  // are COMPLETE on the canvas; it is cleared (before paint, before any
  // canvas write) whenever page/zoom/width/retry or the document changes, so
  // a fast Next→Previous can never re-show a canvas half-way into page 2.
  const generation = useRef(0);
  const [drawn, setDrawn] = useState<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [measureRef, width] = useContentWidth();

  useEffect(() => {
    let cancelled = false;
    let destroy: (() => Promise<void>) | null = null;
    setState({ status: 'loading' });
    (async () => {
      const pdfjs = await loadPdfJs();
      const data = new Uint8Array(await blob.arrayBuffer());
      if (cancelled) return;
      const task = pdfjs.getDocument({
        data,
        ...pdfDocumentOptions(pdfjs.version),
      });
      destroy = () => task.destroy();
      const doc = await task.promise;
      if (cancelled) return;
      setPage((p) => Math.min(Math.max(1, p), doc.numPages));
      setState({ status: 'ready', doc });
    })().catch((e: unknown) => {
      if (!cancelled)
        setState({ status: 'error', ...pdfLoadError(e, subject) });
    });
    return () => {
      cancelled = true;
      void destroy?.();
    };
    // `subject` is fixed for a viewer's life (its caller's context).
  }, [blob, attempt]);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  const settled: ViewerStatus | null =
    state.status === 'error' || pageError !== null
      ? 'error'
      : drawn !== null
        ? 'ready'
        : null;
  useEffect(() => {
    if (settled !== null) statusRef.current?.(settled);
  }, [settled]);

  const doc = state.status === 'ready' ? state.doc : null;
  useLayoutEffect(() => {
    generation.current += 1;
    setDrawn(null);
  }, [doc, page, zoom, width, renderAttempt]);
  useEffect(() => {
    const gen = generation.current;
    setPageError(null);
    const canvas = canvasRef.current;
    if (doc === null || canvas === null || width === 0) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    doc
      .getPage(page)
      .then((p) => {
        if (cancelled) return;
        const base = p.getViewport({ scale: 1 });
        const viewport = p.getViewport({
          scale: (width / base.width) * ZOOMS[zoom],
        });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const out = Math.min(
          dpr,
          Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)),
        );
        // Resizing the backing store also clears the previous page's pixels.
        canvas.width = Math.floor(viewport.width * out);
        canvas.height = Math.floor(viewport.height * out);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        task = p.render({
          canvas,
          viewport,
          transform: out !== 1 ? [out, 0, 0, out, 0, 0] : undefined,
        });
        return task.promise.then(() => {
          if (!cancelled && gen === generation.current) setDrawn(gen);
        });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof Error && e.name === 'RenderingCancelledException')
          return;
        setPageError(
          `Page ${page} could not be drawn: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page, zoom, width, renderAttempt]);

  const goTo = (p: number) => {
    setPage(p);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };

  if (state.status === 'error') {
    return (
      <SourceMessage
        text={state.message}
        onRetry={state.retry ? () => setAttempt((a) => a + 1) : undefined}
      />
    );
  }
  const pages = doc?.numPages ?? 0;
  const shown = doc !== null && pageError === null && drawn !== null;
  return (
    <>
      <Toolbar>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label="Previous page"
            disabled={doc === null || page <= 1}
            onClick={() => goTo(page - 1)}
            className={iconButton}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </button>
          <span
            aria-live="polite"
            className="min-w-[4.5rem] text-center text-[12px] font-semibold tabular-nums text-ink-2"
          >
            {doc === null ? 'Opening…' : `Page ${page} of ${pages}`}
          </span>
          <button
            type="button"
            aria-label="Next page"
            disabled={doc === null || page >= pages}
            onClick={() => goTo(page + 1)}
            className={iconButton}
          >
            <ChevronRight className="size-4" aria-hidden />
          </button>
        </div>
        <ZoomControls zoom={zoom} onZoom={setZoom} />
      </Toolbar>
      <div
        ref={(el) => {
          scrollRef.current = el;
          measureRef(el);
        }}
        className="relative min-h-0 flex-1 overflow-auto p-2"
        style={{ scrollbarGutter: 'stable' }}
      >
        {pageError !== null ? (
          <SourceMessage
            text={pageError}
            onRetry={() => setRenderAttempt((a) => a + 1)}
          />
        ) : (
          !shown && (
            <div className="absolute inset-0 flex">
              <SourceMessage
                text={
                  doc === null ? 'Opening the PDF…' : `Rendering page ${page}…`
                }
                muted
              />
            </div>
          )
        )}
        {/* invisible (not display:none) while drawing: the scroll box keeps
         *  its size, so a zoom/resize re-render does not jump the scroll. */}
        <canvas
          ref={canvasRef}
          role="img"
          aria-hidden={!shown}
          aria-label={`PDF page ${page} of ${pages}`}
          data-drawn-page={shown ? page : undefined}
          className={`block bg-white shadow-sm ${
            pageError !== null ? 'hidden' : shown ? '' : 'invisible'
          }`}
        />
      </div>
    </>
  );
}
