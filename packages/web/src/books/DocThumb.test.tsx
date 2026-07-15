import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  fetchDocumentPreviewObjectUrl: vi.fn(),
}));

import * as api from '../api';
import { DocThumb } from './DocThumb';

describe('DocThumb', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defaults: h-12 w-9 rounded-md border classes and the built-in FileImage fallback glyph', async () => {
    vi.mocked(api.fetchDocumentPreviewObjectUrl).mockRejectedValue(
      new Error('no preview'),
    );
    const { container } = render(<DocThumb id={7} />);

    await waitFor(() => {
      const span = container.querySelector('span[aria-hidden]');
      expect(span).not.toBeNull();
      expect(span).toHaveClass('h-12', 'w-9', 'rounded-md', 'bg-line');
    });
  });

  it('default appearance on success: default className plus object-cover on the <img>', async () => {
    vi.mocked(api.fetchDocumentPreviewObjectUrl).mockResolvedValue(
      'blob:default',
    );
    const { container } = render(<DocThumb id={7} />);

    // The <img> has alt="" (decorative) so it is excluded from the a11y
    // tree's "img" role — query the DOM directly instead of by role.
    const img = await waitFor(() => {
      const el = container.querySelector('img');
      expect(el).not.toBeNull();
      return el as HTMLImageElement;
    });
    expect(img).toHaveAttribute('src', 'blob:default');
    expect(img).toHaveClass(
      'h-12',
      'w-9',
      'rounded-md',
      'border',
      'border-line',
      'object-cover',
    );
  });

  it('respects a custom className on success', async () => {
    vi.mocked(api.fetchDocumentPreviewObjectUrl).mockResolvedValue(
      'blob:custom',
    );
    const { container } = render(
      <DocThumb id={7} className="h-[34px] w-[34px] rounded-[10px]" />,
    );

    const img = await waitFor(() => {
      const el = container.querySelector('img');
      expect(el).not.toBeNull();
      return el as HTMLImageElement;
    });
    expect(img).toHaveClass(
      'h-[34px]',
      'w-[34px]',
      'rounded-[10px]',
      'object-cover',
    );
    expect(img).not.toHaveClass('h-12');
  });

  it('renders the provided fallback instead of the built-in glyph when there is no preview', async () => {
    vi.mocked(api.fetchDocumentPreviewObjectUrl).mockRejectedValue(
      new Error('no preview'),
    );
    render(
      <DocThumb id={7} fallback={<span data-testid="custom-fallback" />} />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('custom-fallback')).toBeInTheDocument(),
    );
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
