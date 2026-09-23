/**
 * Lazy pdf.js loader for the verification source pane (issue #257).
 *
 * The LEGACY build (core + its matching worker, same pdfjs-dist version) is
 * used on purpose: the modern build calls Math.sumPrecise /
 * Uint8Array.fromBase64 unpolyfilled and targets only the latest desktop
 * Firefox/Chrome, while this app is used on phones. Upstream says the legacy
 * build mostly supports Chrome 125+ / Safari 18+; older browsers are not
 * claimed. Both chunks load only when a PDF source is actually shown, and the
 * worker is a bundled local asset (Vite `?url`), never a CDN.
 */
type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

let loading: Promise<PdfJs> | null = null;

export function loadPdfJs(): Promise<PdfJs> {
  loading ??= Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
  ]).then(
    ([pdfjs, worker]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    },
    (e: unknown) => {
      // A failed chunk load (offline, deploy swap) must be retryable.
      loading = null;
      throw e;
    },
  );
  return loading;
}

/**
 * getDocument options for a complete, script-free render. The resource URLs
 * point at the files the Vite `pdfjs-assets` plugin serves/emits from the
 * SAME installed pdfjs-dist version (CMaps for CJK text, standard fonts for
 * non-embedded ones, wasm decoders for JPEG2000/JBIG2 scans, ICC profiles).
 * stopAtErrors: unparseable page content REJECTS the render (shown as an
 * explicit page error with Retry) instead of drawing a silently partial page.
 */
export function pdfDocumentOptions(version: string) {
  const base = new URL(`/pdfjs/${version}/`, window.location.href).href;
  return {
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`,
    iccUrl: `${base}iccs/`,
    isEvalSupported: false,
    enableXfa: false,
    stopAtErrors: true,
  };
}
