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
import { DocThumbLightbox } from './DocThumbLightbox';

/** Distinguish the thumb fetch (no opts) from the lg fetch (`{ size: 'lg' }`),
 *  mirroring the real api.ts contract. */
function respondingByVariant(overrides: { thumb?: string; lg?: string }) {
  return vi.fn(
    async (_id: number, opts: { size?: 'lg' } = {}): Promise<string> =>
      opts.size === 'lg'
        ? (overrides.lg ?? 'blob:lg-default')
        : (overrides.thumb ?? 'blob:thumb-default'),
  );
}

describe('DocThumbLightbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches only the thumb on mount (no lg until opened)', async () => {
    vi.mocked(api.fetchDocumentPreviewObjectUrl).mockImplementation(
      respondingByVariant({ thumb: 'blob:thumb' }),
    );
    render(<DocThumbLightbox id={7} />);

    const thumb = await screen.findByRole('button', {
      name: 'Open document preview',
    });
    // The thumb <img> is decorative (alt="") so it has no "img" role — query
    // the DOM directly.
    expect(thumb.querySelector('img')).toHaveAttribute('src', 'blob:thumb');
    expect(api.fetchDocumentPreviewObjectUrl).toHaveBeenCalledWith(7);
    expect(api.fetchDocumentPreviewObjectUrl).toHaveBeenCalledTimes(1);
  });

  it('opens the full-screen lightbox on click and swaps in the sharp lg variant', async () => {
    vi.mocked(api.fetchDocumentPreviewObjectUrl).mockImplementation(
      respondingByVariant({ thumb: 'blob:thumb', lg: 'blob:lg' }),
    );
    render(<DocThumbLightbox id={7} />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Open document preview' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Document preview',
    });

    expect(api.fetchDocumentPreviewObjectUrl).toHaveBeenCalledWith(7, {
      size: 'lg',
    });
    await waitFor(() =>
      expect(within(dialog).getByAltText('Document preview')).toHaveAttribute(
        'src',
        'blob:lg',
      ),
    );
  });

  it('renders the fallback with no button when there is no preview', async () => {
    vi.mocked(api.fetchDocumentPreviewObjectUrl).mockRejectedValue(
      new Error('no preview'),
    );
    render(
      <DocThumbLightbox id={7} fallback={<span data-testid="glyph">?</span>} />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('glyph')).toBeInTheDocument(),
    );
    // No preview → not interactive, so a tap falls through to the row.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
