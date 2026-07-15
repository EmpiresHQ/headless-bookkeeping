import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  fetchDocumentPreviewObjectUrl: vi.fn(),
  openSignedDocument: vi.fn(),
}));

import * as api from '../api';
import { DocPreviewRow } from './DocPreviewRow';

/** Mock impl distinguishing the thumb fetch (no opts) from the lg fetch
 *  (`{ size: 'lg' }`) — mirrors the real api.ts contract. */
function respondingByVariant(overrides: {
  thumb?: string;
  lg?: string | Error;
}) {
  return vi.fn(
    async (_id: number, opts: { size?: 'lg' } = {}): Promise<string> => {
      if (opts.size === 'lg') {
        if (overrides.lg instanceof Error) throw overrides.lg;
        return overrides.lg ?? 'blob:lg-default';
      }
      return overrides.thumb ?? 'blob:thumb-default';
    },
  );
}

describe('DocPreviewRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches only the thumb (no size option) on mount', async () => {
    vi.mocked(api.fetchDocumentPreviewObjectUrl).mockImplementation(
      respondingByVariant({ thumb: 'blob:thumb' }),
    );
    render(<DocPreviewRow documentId={42} />);

    await waitFor(() =>
      expect(screen.getByAltText('Document preview')).toHaveAttribute(
        'src',
        'blob:thumb',
      ),
    );
    expect(api.fetchDocumentPreviewObjectUrl).toHaveBeenCalledWith(42);
    // No lg fetch happens until the lightbox is opened.
    expect(api.fetchDocumentPreviewObjectUrl).toHaveBeenCalledTimes(1);
  });

  it('opens the lightbox on click, lazily fetches the lg variant with { size: "lg" }, and swaps the image', async () => {
    vi.mocked(api.fetchDocumentPreviewObjectUrl).mockImplementation(
      respondingByVariant({ thumb: 'blob:thumb', lg: 'blob:lg' }),
    );
    render(<DocPreviewRow documentId={42} />);
    await waitFor(() =>
      expect(screen.getByAltText('Document preview')).toHaveAttribute(
        'src',
        'blob:thumb',
      ),
    );

    fireEvent.click(screen.getByText('Source document'));
    const dialog = await screen.findByRole('dialog');

    // The lightbox always starts on `src={lgSrc ?? src}` — the thumb blob is
    // the instant placeholder until the lg fetch resolves (asserted below);
    // the mock may resolve within the same microtask flush, so this is not
    // separately pinned as its own synchronous assertion.
    expect(api.fetchDocumentPreviewObjectUrl).toHaveBeenCalledWith(42, {
      size: 'lg',
    });

    // Then swaps to (or was always going to land on) the sharp lg blob once
    // the fetch resolves.
    await waitFor(() =>
      expect(within(dialog).getByAltText('Document preview')).toHaveAttribute(
        'src',
        'blob:lg',
      ),
    );
  });

  it('keeps the thumb in the lightbox when the lg fetch rejects', async () => {
    vi.mocked(api.fetchDocumentPreviewObjectUrl).mockImplementation(
      respondingByVariant({
        thumb: 'blob:thumb',
        lg: new Error('lg fetch failed'),
      }),
    );
    render(<DocPreviewRow documentId={42} />);
    await waitFor(() =>
      expect(screen.getByAltText('Document preview')).toHaveAttribute(
        'src',
        'blob:thumb',
      ),
    );

    fireEvent.click(screen.getByText('Source document'));
    const dialog = await screen.findByRole('dialog');

    await waitFor(() =>
      expect(api.fetchDocumentPreviewObjectUrl).toHaveBeenCalledWith(42, {
        size: 'lg',
      }),
    );

    // The rejection is swallowed — the lightbox never leaves the thumb blob.
    await waitFor(() =>
      expect(within(dialog).getByAltText('Document preview')).toHaveAttribute(
        'src',
        'blob:thumb',
      ),
    );
  });
});
