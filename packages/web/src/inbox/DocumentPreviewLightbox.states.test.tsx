import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  fetchDocumentPreviewObjectUrl: vi.fn(),
  openSignedDocument: vi.fn(),
}));

import * as api from '../api';
import { HttpError, SessionChangedError } from '../auth';
import { DocPreviewRow } from './DocPreviewRow';
import { DocThumbLightbox } from './DocThumbLightbox';
import { usePreviewObjectUrl } from './DocumentPreviewLightbox';

/** Issue #270: loading, "no preview" (404) and failure are distinct, each
 *  with Retry and Open original; results are bound to the document and
 *  variant they were read for. */

interface Call {
  id: number;
  variant: 'thumb' | 'lg';
  resolve: (url: string) => void;
  reject: (e: unknown) => void;
}

let calls: Call[] = [];
let revoked: string[] = [];

/** The latest pending read of `id`/`variant`. */
function call(id: number, variant: 'thumb' | 'lg'): Call {
  const found = calls.filter((c) => c.id === id && c.variant === variant);
  if (found.length === 0) throw new Error(`no ${variant} read of ${id}`);
  return found[found.length - 1];
}
const reads = (id: number, variant: 'thumb' | 'lg') =>
  calls.filter((c) => c.id === id && c.variant === variant).length;

async function settle(c: Call, outcome: string | Error) {
  await act(async () => {
    if (typeof outcome === 'string') c.resolve(outcome);
    else c.reject(outcome);
  });
}

const notFound = () => new HttpError(404, '404 Not Found: no preview');
const unavailable503 = () =>
  new HttpError(503, '503 Service Unavailable: storage');

beforeEach(() => {
  calls = [];
  revoked = [];
  vi.mocked(api.fetchDocumentPreviewObjectUrl).mockImplementation(
    (id: number, opts: { size?: 'lg' } = {}) =>
      new Promise<string>((resolve, reject) => {
        calls.push({
          id,
          variant: opts.size === 'lg' ? 'lg' : 'thumb',
          resolve,
          reject,
        });
      }),
  );
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => {
    revoked.push(u);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const status = (dialog: HTMLElement) => within(dialog).getByRole('status');
const image = (dialog: HTMLElement) =>
  within(dialog).queryByAltText('Document preview');
const retryButton = (dialog: HTMLElement) =>
  within(dialog).queryByRole('button', { name: /Retry/ });

async function openRow() {
  fireEvent.click(screen.getByRole('button', { name: /Source document/ }));
  return screen.findByRole('dialog', { name: 'Document preview' });
}

describe('preview states in the lightbox (DocPreviewRow)', () => {
  it('loading is not "no preview": both reads pending shows Loading, Open original, no Retry', async () => {
    render(<DocPreviewRow documentId={12} />);
    expect(
      screen.getByRole('button', { name: /Source document/ }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('loading preview')).toBeInTheDocument();
    const dialog = await openRow();
    expect(status(dialog)).toHaveTextContent('Loading preview…');
    expect(status(dialog)).not.toHaveTextContent(/No preview/);
    expect(image(dialog)).toBeNull();
    expect(retryButton(dialog)).toBeNull();
    expect(
      within(dialog).getByRole('button', { name: 'Open original' }),
    ).toBeInTheDocument();
  });

  it('404 is "no preview" without claiming the original is missing, with Retry', async () => {
    render(<DocPreviewRow documentId={12} />);
    await settle(call(12, 'thumb'), notFound());
    expect(screen.getByLabelText('no preview')).toBeInTheDocument();
    const dialog = await openRow();
    await settle(call(12, 'lg'), notFound());
    expect(status(dialog)).toHaveTextContent(
      'No preview is available for this document. You can still try Open original.',
    );
    expect(status(dialog)).not.toHaveTextContent(/missing|deleted/i);
    expect(retryButton(dialog)).toHaveTextContent('Retry');
    // A 404 can be a failed render: a deliberate Retry may recover it.
    fireEvent.click(retryButton(dialog)!);
    expect(reads(12, 'lg')).toBe(2);
    expect(reads(12, 'thumb')).toBe(2);
    await settle(call(12, 'thumb'), 'blob:t12b');
    await settle(call(12, 'lg'), 'blob:lg12b');
    expect(image(dialog)).toHaveAttribute('src', 'blob:lg12b');
    expect(status(dialog)).toHaveTextContent('');
    expect(retryButton(dialog)).toBeNull();
  });

  it.each([
    ['a 503', unavailable503],
    ['a network failure', () => new TypeError('Failed to fetch')],
    ['an ended session', () => new SessionChangedError()],
    ['an unknown error', () => new Error('weird')],
  ])('%s is a retryable error, never "no preview"', async (_l, err) => {
    render(<DocPreviewRow documentId={12} />);
    await settle(call(12, 'thumb'), err());
    expect(screen.getByLabelText('preview failed to load')).toBeInTheDocument();
    const dialog = await openRow();
    await settle(call(12, 'lg'), err());
    expect(status(dialog)).toHaveTextContent('The preview couldn’t be loaded.');
    expect(status(dialog)).not.toHaveTextContent(/No preview/);
    expect(retryButton(dialog)).toBeInTheDocument();
  });

  it('Retry is single flight, re-reads only the previews of this document, and never writes', async () => {
    render(<DocPreviewRow documentId={12} />);
    await settle(call(12, 'thumb'), 'blob:t12');
    const dialog = await openRow();
    await settle(call(12, 'lg'), unavailable503());
    // Honest partial success: the thumbnail, qualified.
    expect(image(dialog)).toHaveAttribute('src', 'blob:t12');
    expect(status(dialog)).toHaveTextContent(
      'The full-size preview couldn’t be loaded — showing a smaller one.',
    );
    const retry = retryButton(dialog)!;
    fireEvent.click(retry);
    expect(retry).toHaveAttribute('aria-disabled', 'true');
    expect(retry).toHaveTextContent('Retrying…');
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(reads(12, 'lg')).toBe(2);
    // The ready thumbnail is not re-read.
    expect(reads(12, 'thumb')).toBe(1);
    expect(calls.every((c) => c.id === 12)).toBe(true);
    expect(api.openSignedDocument).not.toHaveBeenCalled();
    await settle(call(12, 'lg'), 'blob:lg12');
    expect(image(dialog)).toHaveAttribute('src', 'blob:lg12');
  });

  it('a lg image that fails to decode becomes a retryable error over the thumbnail', async () => {
    render(<DocPreviewRow documentId={12} />);
    await settle(call(12, 'thumb'), 'blob:t12');
    const dialog = await openRow();
    await settle(call(12, 'lg'), 'blob:lg12');
    fireEvent.error(image(dialog)!);
    expect(image(dialog)).toHaveAttribute('src', 'blob:t12');
    expect(status(dialog)).toHaveTextContent(/couldn’t be loaded/);
    fireEvent.click(retryButton(dialog)!);
    // The broken URL is released as its run ends.
    expect(revoked).toContain('blob:lg12');
    expect(reads(12, 'lg')).toBe(2);
  });

  it('an error queued by an earlier image never fails the newer one', async () => {
    const { rerender } = render(<DocPreviewRow documentId={12} />);
    await settle(call(12, 'thumb'), 'blob:t12');
    const dialog = await openRow();
    const thumbImg = image(dialog)!;
    expect(thumbImg).toHaveAttribute('src', 'blob:t12');
    await settle(call(12, 'lg'), 'blob:lg12');
    const lgImg = image(dialog)!;
    // A new node per URL: the thumb's node is gone, not re-pointed.
    expect(lgImg).not.toBe(thumbImg);
    fireEvent.error(thumbImg);
    expect(image(dialog)).toHaveAttribute('src', 'blob:lg12');
    expect(retryButton(dialog)).toBeNull();

    // Same for the next document: 12's late lg error can't fail 13.
    rerender(<DocPreviewRow documentId={13} />);
    await settle(call(13, 'lg'), 'blob:lg13');
    fireEvent.error(lgImg);
    expect(image(dialog)).toHaveAttribute('src', 'blob:lg13');
    expect(status(dialog)).toHaveTextContent('');
    // Malformed bytes of the CURRENT image are a retryable error.
    fireEvent.error(image(dialog)!);
    expect(retryButton(dialog)).toHaveTextContent('Retry');
  });

  it('queue advance with the preview closed: nothing of the old document, no lg prefetch', async () => {
    const { rerender } = render(<DocPreviewRow documentId={12} />);
    await settle(call(12, 'thumb'), 'blob:t12');
    let dialog = await openRow();
    await settle(call(12, 'lg'), 'blob:lg12');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Queue advance: the same instance now shows document 13.
    rerender(<DocPreviewRow documentId={13} />);
    expect(screen.queryByAltText('Document preview')).toBeNull();
    expect(screen.getByLabelText('loading preview')).toBeInTheDocument();
    expect(revoked).toEqual(expect.arrayContaining(['blob:t12', 'blob:lg12']));
    expect(reads(13, 'lg')).toBe(0);

    // 13 fails: an error, never 12's picture.
    await settle(call(13, 'thumb'), unavailable503());
    dialog = await openRow();
    expect(reads(13, 'lg')).toBe(1);
    expect(image(dialog)).toBeNull();
    await settle(call(13, 'lg'), unavailable503());
    expect(image(dialog)).toBeNull();
    expect(status(dialog)).toHaveTextContent('The preview couldn’t be loaded.');
  });

  it('document change while the preview is open: at once loading, the new lg is read', async () => {
    const { rerender } = render(<DocPreviewRow documentId={12} />);
    await settle(call(12, 'thumb'), 'blob:t12');
    const dialog = await openRow();
    await settle(call(12, 'lg'), 'blob:lg12');
    expect(image(dialog)).toHaveAttribute('src', 'blob:lg12');
    rerender(<DocPreviewRow documentId={13} />);
    expect(image(dialog)).toBeNull();
    expect(status(dialog)).toHaveTextContent('Loading preview…');
    expect(revoked).toEqual(expect.arrayContaining(['blob:t12', 'blob:lg12']));
    expect(reads(13, 'lg')).toBe(1);
    await settle(call(13, 'lg'), 'blob:lg13');
    expect(image(dialog)).toHaveAttribute('src', 'blob:lg13');
  });

  it('A → B (held) → A never resurfaces A’s revoked URL; late B is dropped', async () => {
    const { rerender } = render(<DocPreviewRow documentId={12} />);
    await settle(call(12, 'thumb'), 'blob:t12');
    expect(screen.getByAltText('Document preview')).toHaveAttribute(
      'src',
      'blob:t12',
    );
    rerender(<DocPreviewRow documentId={13} />);
    const heldB = call(13, 'thumb');
    expect(revoked).toContain('blob:t12');
    // Back to A before B answers: a new read, not the revoked old one.
    rerender(<DocPreviewRow documentId={12} />);
    expect(screen.queryByAltText('Document preview')).toBeNull();
    expect(screen.getByLabelText('loading preview')).toBeInTheDocument();
    expect(reads(12, 'thumb')).toBe(2);
    await settle(heldB, 'blob:late-t13');
    expect(revoked).toContain('blob:late-t13');
    expect(screen.queryByAltText('Document preview')).toBeNull();
    await settle(call(12, 'thumb'), 'blob:t12-again');
    expect(screen.getByAltText('Document preview')).toHaveAttribute(
      'src',
      'blob:t12-again',
    );
  });

  it('late answers of the previous document never land and their URLs are revoked', async () => {
    const { rerender } = render(<DocPreviewRow documentId={12} />);
    const oldThumb = call(12, 'thumb');
    await openRow();
    const oldLg = call(12, 'lg');
    rerender(<DocPreviewRow documentId={13} />);
    await settle(oldThumb, 'blob:late-t12');
    await settle(oldLg, 'blob:late-lg12');
    expect(revoked).toEqual(
      expect.arrayContaining(['blob:late-t12', 'blob:late-lg12']),
    );
    expect(screen.queryByAltText('Document preview')).toBeNull();
    // …and a late failure of the old document is not 13's failure.
    rerender(<DocPreviewRow documentId={14} />);
    await settle(call(13, 'thumb'), notFound());
    expect(screen.getByLabelText('loading preview')).toBeInTheDocument();
  });

  it('reopening keeps the fetched lg; a failed lg stays failed until Retry', async () => {
    render(<DocPreviewRow documentId={12} />);
    await settle(call(12, 'thumb'), 'blob:t12');
    let dialog = await openRow();
    await settle(call(12, 'lg'), unavailable503());
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    dialog = await openRow();
    expect(reads(12, 'lg')).toBe(1);
    expect(retryButton(dialog)).toHaveTextContent('Retry');
  });

  it('a closed lightbox announces nothing', async () => {
    render(<DocPreviewRow documentId={12} />);
    await settle(call(12, 'thumb'), unavailable503());
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Retry focus stays in the modal', () => {
  it('keeps focus on Retry while retrying and on a new failure; moves to Close when it succeeds', async () => {
    render(<DocPreviewRow documentId={12} />);
    await settle(call(12, 'thumb'), 'blob:t12');
    const dialog = await openRow();
    await settle(call(12, 'lg'), unavailable503());
    const close = within(dialog).getByRole('button', { name: 'Close preview' });
    const retry = retryButton(dialog)!;
    retry.focus();
    fireEvent.click(retry);
    expect(retry).toHaveFocus();
    await settle(call(12, 'lg'), unavailable503());
    expect(retryButton(dialog)).toBe(retry);
    expect(retry).toHaveFocus();
    fireEvent.click(retry);
    await settle(call(12, 'lg'), 'blob:lg12');
    expect(retryButton(dialog)).toBeNull();
    expect(close).toHaveFocus();
  });

  it('never moves focus as requests settle when Retry was not focused', async () => {
    render(<DocPreviewRow documentId={12} />);
    await settle(call(12, 'thumb'), 'blob:t12');
    const dialog = await openRow();
    const open = within(dialog).getByRole('button', { name: 'Open original' });
    open.focus();
    await settle(call(12, 'lg'), unavailable503());
    expect(open).toHaveFocus();
    fireEvent.click(retryButton(dialog)!);
    await settle(call(12, 'lg'), 'blob:lg12');
    expect(open).toHaveFocus();
  });
});

describe('DocThumbLightbox (Inbox)', () => {
  it.each([
    ['loading', async () => undefined],
    ['404', () => settle(call(7, 'thumb'), notFound())],
    ['503', () => settle(call(7, 'thumb'), unavailable503())],
  ])(
    '%s thumb: the row glyph, no button (the tap navigates with the row)',
    async (_l, act_) => {
      render(
        <DocThumbLightbox id={7} fallback={<span data-testid="glyph" />} />,
      );
      await act_();
      expect(screen.getByTestId('glyph')).toBeInTheDocument();
      expect(screen.queryByRole('button')).toBeNull();
    },
  );

  it('close releases lg; reopening (same key) never shows the revoked URL', async () => {
    render(<DocThumbLightbox id={7} />);
    await settle(call(7, 'thumb'), 'blob:t7');
    const thumb = screen.getByRole('button', { name: 'Open document preview' });
    fireEvent.click(thumb);
    let dialog = await screen.findByRole('dialog');
    await settle(call(7, 'lg'), 'blob:lg7');
    expect(image(dialog)).toHaveAttribute('src', 'blob:lg7');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(revoked).toContain('blob:lg7');

    fireEvent.click(thumb);
    dialog = await screen.findByRole('dialog');
    expect(reads(7, 'lg')).toBe(2);
    expect(image(dialog)).toHaveAttribute('src', 'blob:t7');
    expect(status(dialog)).toHaveTextContent('Loading full-size preview…');
    await settle(call(7, 'lg'), 'blob:lg7b');
    expect(image(dialog)).toHaveAttribute('src', 'blob:lg7b');
  });

  it('lg failure over a ready thumbnail is qualified and retryable', async () => {
    render(<DocThumbLightbox id={7} />);
    await settle(call(7, 'thumb'), 'blob:t7');
    fireEvent.click(
      screen.getByRole('button', { name: 'Open document preview' }),
    );
    const dialog = await screen.findByRole('dialog');
    await settle(call(7, 'lg'), notFound());
    expect(image(dialog)).toHaveAttribute('src', 'blob:t7');
    expect(status(dialog)).toHaveTextContent(
      'Full-size preview isn’t available — showing a smaller one.',
    );
    fireEvent.click(retryButton(dialog)!);
    expect(reads(7, 'lg')).toBe(2);
  });
});

describe('usePreviewObjectUrl', () => {
  it('same variant A → B (held) → A: loading, then only the new A read', async () => {
    const { result, rerender } = renderHook(
      ({ id }) => usePreviewObjectUrl(id, { size: 'lg' }),
      { initialProps: { id: 1 } },
    );
    await settle(call(1, 'lg'), 'blob:A');
    const brokenA = result.current.reportBroken;
    rerender({ id: 2 });
    rerender({ id: 1 });
    expect(result.current.status).toBe('loading');
    // The old image's onError closure can't touch the new run.
    act(() => brokenA('blob:A'));
    expect(result.current.status).toBe('loading');
    await settle(call(2, 'lg'), 'blob:B');
    expect(result.current.status).toBe('loading');
    expect(revoked).toEqual(expect.arrayContaining(['blob:A', 'blob:B']));
    await settle(call(1, 'lg'), 'blob:A2');
    expect(result.current).toMatchObject({ status: 'ready', src: 'blob:A2' });
  });

  it('inactive → active: the first active render is loading, never the previous activation', async () => {
    const { result, rerender } = renderHook(
      ({ active }) => usePreviewObjectUrl(5, { size: 'lg', active }),
      { initialProps: { active: true } },
    );
    await settle(call(5, 'lg'), 'blob:a');
    expect(result.current).toMatchObject({ status: 'ready', src: 'blob:a' });
    const seen: unknown[] = [];
    rerender({ active: false });
    seen.push(result.current.status);
    expect(revoked).toContain('blob:a');
    rerender({ active: true });
    seen.push({ ...result.current });
    expect(seen).toEqual([
      'idle',
      expect.objectContaining({ status: 'loading' }),
    ]);
    expect(reads(5, 'lg')).toBe(2);
  });

  it('StrictMode: every minted URL is revoked once its owner is gone', async () => {
    const created: string[] = [];
    let n = 0;
    vi.mocked(api.fetchDocumentPreviewObjectUrl).mockImplementation(
      async () => {
        const u = `blob:s${n++}`;
        created.push(u);
        return u;
      },
    );
    const { unmount } = renderHook(() => usePreviewObjectUrl(5), {
      wrapper: StrictMode,
    });
    await act(async () => undefined);
    unmount();
    expect(created.length).toBeGreaterThan(0);
    expect([...revoked].sort()).toEqual([...created].sort());
  });

  it('unmounted mid-flight: the late URL is revoked', async () => {
    const { unmount } = renderHook(() => usePreviewObjectUrl(5));
    unmount();
    await settle(call(5, 'thumb'), 'blob:gone');
    expect(revoked).toEqual(['blob:gone']);
  });
});
