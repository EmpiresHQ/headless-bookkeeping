import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  fetchDocumentFile: vi.fn(),
  fetchDocumentPreviewBlob: vi.fn(),
  openSignedDocument: vi.fn(),
}));
vi.mock('./pdfjs', () => ({
  loadPdfJs: vi.fn(),
  pdfDocumentOptions: () => ({ isEvalSupported: false }),
}));
vi.mock('../ui/toast', () => ({ toastErr: vi.fn(), toastOk: vi.fn() }));

import * as api from '../api';
import { HttpError } from '../auth';
import { toastErr } from '../ui/toast';
import { DocumentSourcePane } from './DocumentSourcePane';
import * as pdfjs from './pdfjs';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A fake pdf.js whose page renders stay pending until the test settles
 *  them — the delayed-render races are driven explicitly. */
function fakePdf(numPages: number) {
  const renders: {
    page: number;
    done: ReturnType<typeof deferred<void>>;
    cancel: ReturnType<typeof vi.fn>;
  }[] = [];
  const doc = {
    numPages,
    getPage: vi.fn(async (page: number) => ({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
      }),
      render: () => {
        const done = deferred<void>();
        const cancel = vi.fn(() => {
          const e = new Error('cancelled');
          e.name = 'RenderingCancelledException';
          done.reject(e);
        });
        renders.push({ page, done, cancel });
        return { promise: done.promise, cancel };
      },
    })),
  };
  const getDocument = vi.fn(() => ({
    promise: Promise.resolve(doc),
    destroy: vi.fn(async () => undefined),
  }));
  return { doc, renders, getDocument, lib: { getDocument, version: 'x' } };
}

const pdfFile = () => ({
  blob: new Blob(['%PDF-1.7'], { type: 'application/pdf' }),
  filename: 'scan.pdf',
});

function renderPane(documentId = 12) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <DocumentSourcePane documentId={documentId} active />
    </QueryClientProvider>,
  );
}

const canvas = () => document.querySelector('canvas') as HTMLCanvasElement;
const pageShown = () => canvas().getAttribute('data-drawn-page');

// jsdom has no layout: give every element a width so the viewer renders.
const clientWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'clientWidth',
);
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 400,
  });
  if (typeof Blob.prototype.arrayBuffer !== 'function') {
    Blob.prototype.arrayBuffer = function () {
      return Promise.resolve(new ArrayBuffer(8));
    };
  }
});
afterAll(() => {
  if (clientWidth)
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth);
});

describe('DocumentSourcePane — PDF', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.fetchDocumentFile).mockResolvedValue(pdfFile());
  });

  it('renders every page one at a time and never shows the old page under a new label', async () => {
    const pdf = fakePdf(5);
    vi.mocked(pdfjs.loadPdfJs).mockResolvedValue(pdf.lib as never);
    renderPane();

    expect(await screen.findByText('Page 1 of 5')).toBeInTheDocument();
    await waitFor(() => expect(pdf.renders).toHaveLength(1));
    // Rendering: canvas held back until page 1 is complete.
    expect(pageShown()).toBeNull();
    expect(canvas()).toHaveClass('invisible');
    expect(screen.getByText('Rendering page 1…')).toBeInTheDocument();
    await act(async () => pdf.renders[0].done.resolve());
    expect(pageShown()).toBe('1');
    expect(canvas()).not.toHaveClass('invisible');

    // Page 2 is slow: the label moves at once, page 1's pixels are hidden.
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('Page 2 of 5')).toBeInTheDocument();
    expect(pageShown()).toBeNull();
    expect(canvas()).toHaveClass('invisible');
    expect(screen.getByText('Rendering page 2…')).toBeInTheDocument();
    await waitFor(() => expect(pdf.renders).toHaveLength(2));
    expect(pdf.renders[1].page).toBe(2);
    await act(async () => pdf.renders[1].done.resolve());
    expect(pageShown()).toBe('2');
    expect(pdf.doc.getPage).toHaveBeenLastCalledWith(2);
  });

  it('rapid Next→Previous during a delayed render never re-shows a half-drawn canvas', async () => {
    const pdf = fakePdf(5);
    vi.mocked(pdfjs.loadPdfJs).mockResolvedValue(pdf.lib as never);
    renderPane();
    await waitFor(() => expect(pdf.renders).toHaveLength(1));
    await act(async () => pdf.renders[0].done.resolve());
    expect(pageShown()).toBe('1');

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(pdf.renders).toHaveLength(2));
    // Page 2 is mid-draw on the shared canvas; go straight back to page 1.
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(screen.getByText('Page 1 of 5')).toBeInTheDocument();
    // Same page/zoom/width as the earlier completed render — still hidden.
    expect(pageShown()).toBeNull();
    expect(canvas()).toHaveClass('invisible');
    await waitFor(() => expect(pdf.renders).toHaveLength(3));
    expect(pdf.renders[1].cancel).toHaveBeenCalled();
    // A late page-2 completion cannot mark the canvas drawn either.
    await act(async () => pdf.renders[1].done.resolve());
    expect(pageShown()).toBeNull();
    await act(async () => pdf.renders[2].done.resolve());
    expect(pageShown()).toBe('1');
  });

  it('a failed page render hides the canvas and retries on demand', async () => {
    const pdf = fakePdf(2);
    vi.mocked(pdfjs.loadPdfJs).mockResolvedValue(pdf.lib as never);
    renderPane();
    await waitFor(() => expect(pdf.renders).toHaveLength(1));
    await act(async () => pdf.renders[0].done.resolve());
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(pdf.renders).toHaveLength(2));
    await act(async () => pdf.renders[1].done.reject(new Error('bad stream')));
    expect(
      screen.getByText('Page 2 could not be drawn: bad stream'),
    ).toBeInTheDocument();
    expect(canvas()).toHaveClass('hidden');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(pdf.renders).toHaveLength(3));
    await act(async () => pdf.renders[2].done.resolve());
    expect(pageShown()).toBe('2');
  });

  it('keeps zoom and page across remeasure-free re-renders (zoom re-draws, page kept)', async () => {
    const pdf = fakePdf(3);
    vi.mocked(pdfjs.loadPdfJs).mockResolvedValue(pdf.lib as never);
    renderPane();
    await waitFor(() => expect(pdf.renders).toHaveLength(1));
    await act(async () => pdf.renders[0].done.resolve());
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(pdf.renders).toHaveLength(2));
    await act(async () => pdf.renders[1].done.resolve());
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByRole('button', { name: 'Fit width' })).toHaveTextContent(
      '150%',
    );
    await waitFor(() => expect(pdf.renders).toHaveLength(3));
    expect(pdf.renders[2].page).toBe(2);
    // 400px pane / 600pt page × 1.5 → 600 css px wide.
    expect(canvas().style.width).toBe('600px');
  });

  it('password-protected: explicit message, no pointless retry', async () => {
    const e = new Error('No password given');
    e.name = 'PasswordException';
    vi.mocked(pdfjs.loadPdfJs).mockResolvedValue({
      version: 'x',
      getDocument: () => ({
        promise: Promise.reject(e),
        destroy: async () => undefined,
      }),
    } as never);
    renderPane();
    expect(
      await screen.findByText(/password-protected and can’t be shown here/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    // The original stays reachable.
    expect(screen.getByRole('link', { name: /Download/ })).toBeInTheDocument();
  });

  it('corrupt PDF / viewer load failure: explicit error, Retry reopens and renders on the new scroll box', async () => {
    const bad = new Error('Invalid PDF structure.');
    bad.name = 'InvalidPDFException';
    const pdf = fakePdf(1);
    vi.mocked(pdfjs.loadPdfJs)
      .mockRejectedValueOnce(bad)
      .mockResolvedValue(pdf.lib as never);
    renderPane();
    expect(
      await screen.findByText(/damaged or not a valid PDF/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Page 1 of 1')).toBeInTheDocument();
    // The replaced scroll element is measured again (callback ref), so the
    // page actually renders after Retry.
    await waitFor(() => expect(pdf.renders).toHaveLength(1));
    await act(async () => pdf.renders[0].done.resolve());
    expect(pageShown()).toBe('1');
  });
});

describe('DocumentSourcePane — file states and actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loading, then a missing file (404) with Retry that refetches', async () => {
    const file = deferred<Awaited<ReturnType<typeof api.fetchDocumentFile>>>();
    vi.mocked(api.fetchDocumentFile)
      .mockRejectedValueOnce(new HttpError(404, '404 Not Found: gone'))
      .mockReturnValueOnce(file.promise);
    renderPane();
    expect(
      await screen.findByText(/source file is missing/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByText('Loading the source document…'),
    ).toBeInTheDocument();
    await act(async () =>
      file.resolve({
        blob: new Blob(['x'], { type: 'image/png' }),
        filename: 'r.png',
      }),
    );
    expect(await screen.findByAltText('Source document')).toBeInTheDocument();
    expect(api.fetchDocumentFile).toHaveBeenCalledTimes(2);
    expect(api.fetchDocumentFile).toHaveBeenCalledWith(12);
  });

  it('a long image scrolls and zooms past the pane width', async () => {
    vi.mocked(api.fetchDocumentFile).mockResolvedValue({
      blob: new Blob(['x'], { type: 'image/png' }),
      filename: 'long-receipt.png',
    });
    renderPane();
    const img = await screen.findByAltText('Source document');
    expect(img.style.width).toBe('100%');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(img.style.width).toBe('200%');
    expect(img.parentElement).toHaveClass('overflow-auto');
    expect(screen.getByText('long-receipt.png')).toBeInTheDocument();
  });

  it('HEIC: honest first-page fallback, download only (no new tab)', async () => {
    vi.mocked(api.fetchDocumentFile).mockResolvedValue({
      blob: new Blob(['x'], { type: 'image/heic' }),
      filename: 'IMG_1.heic',
    });
    vi.mocked(api.fetchDocumentPreviewBlob).mockResolvedValue(
      new Blob(['png'], { type: 'image/png' }),
    );
    renderPane();
    expect(
      await screen.findByAltText('Source document, first page'),
    ).toBeInTheDocument();
    expect(screen.getByText(/First page only/)).toHaveTextContent(
      "This file type (image/heic) can't be shown in full here",
    );
    expect(api.fetchDocumentPreviewBlob).toHaveBeenCalledWith(12, {
      size: 'lg',
    });
    expect(screen.getByRole('link', { name: /Download/ })).toHaveAttribute(
      'download',
      'IMG_1.heic',
    );
    expect(screen.queryByRole('button', { name: /New tab/ })).toBeNull();
  });

  it('HTML/SVG blobs are never opened as a page — download only', async () => {
    vi.mocked(api.fetchDocumentFile).mockResolvedValue({
      blob: new Blob(['<script>'], { type: 'text/html' }),
      filename: 'x.html',
    });
    vi.mocked(api.fetchDocumentPreviewBlob).mockRejectedValue(
      new HttpError(404, '404 Not Found: no preview'),
    );
    renderPane();
    expect(
      await screen.findByText(/This file type \(text\/html\)/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New tab/ })).toBeNull();
    expect(screen.getByRole('link', { name: /Download/ })).toBeInTheDocument();
  });

  it('a blocked popup reports it and never navigates this tab', async () => {
    vi.mocked(api.fetchDocumentFile).mockResolvedValue({
      blob: new Blob(['x'], { type: 'image/jpeg' }),
      filename: 'r.jpg',
    });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const href = window.location.href;
    renderPane();
    const region = await screen.findByRole('region', {
      name: 'Source document',
    });
    fireEvent.click(
      await within(region).findByRole('button', { name: /New tab/ }),
    );
    expect(open).toHaveBeenCalledWith(
      expect.stringMatching(/^blob:/),
      '_blank',
    );
    expect(toastErr).toHaveBeenCalledWith(
      'The browser blocked the new tab — use Download instead.',
    );
    expect(window.location.href).toBe(href);
    expect(api.openSignedDocument).not.toHaveBeenCalled();
    open.mockRestore();
  });
});
