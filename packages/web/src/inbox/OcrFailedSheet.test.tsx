import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  uploadDocument: vi.fn(),
  triageDocument: vi.fn(),
  completeDocument: vi.fn(),
  retryDocument: vi.fn(),
}));

import * as api from '../api';
import { OcrFailedSheet } from './OcrFailedSheet';

describe('OcrFailedSheet', () => {
  beforeEach(() => vi.clearAllMocks());

  function renderSheet(onReplaced = vi.fn(), onRetried = vi.fn()) {
    render(
      <OcrFailedSheet
        documentId={12}
        open
        onOpenChange={() => undefined}
        onReplaced={onReplaced}
        onRetried={onRetried}
      />,
    );
    return { onReplaced, onRetried };
  }

  it('retries OCR on the same file', async () => {
    vi.mocked(api.retryDocument).mockResolvedValue({ ok: true });
    const { onRetried } = renderSheet();
    fireEvent.click(
      screen.getByRole('button', { name: 'Retry OCR on this file' }),
    );
    await waitFor(() => expect(api.retryDocument).toHaveBeenCalledWith(12));
    expect(onRetried).toHaveBeenCalled();
  });

  it('uploads a replacement, triages it, and dismisses the broken original', async () => {
    vi.mocked(api.uploadDocument).mockResolvedValue({
      document: {
        id: 99,
        filename: 'better.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 1,
        status: 'pending',
        processing_since: null,
        created_at: 1,
      },
      deduplicated: false,
    });
    const outcome = {
      kind: 'expense',
      document_id: 99,
      expense_id: 7,
    } as const;
    vi.mocked(api.triageDocument).mockResolvedValue(outcome);
    vi.mocked(api.completeDocument).mockResolvedValue({
      id: 12,
      status: 'processed',
    });
    const { onReplaced } = renderSheet();
    fireEvent.change(screen.getByLabelText('Replacement file'), {
      target: {
        files: [new File(['x'], 'better.jpg', { type: 'image/jpeg' })],
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upload replacement' }));
    await waitFor(() => expect(api.triageDocument).toHaveBeenCalledWith(99));
    await waitFor(() => expect(api.completeDocument).toHaveBeenCalledWith(12));
    expect(onReplaced).toHaveBeenCalledWith(outcome);
    // ORDER matters: the replacement must be triaged (booked) BEFORE the
    // broken original is archived, or a failure between the two calls
    // would dismiss doc 12 with nothing booked in its place.
    expect(
      vi.mocked(api.triageDocument).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(api.completeDocument).mock.invocationCallOrder[0]);
  });

  it('disables Upload replacement until a file is chosen', () => {
    renderSheet();
    expect(
      screen.getByRole('button', { name: 'Upload replacement' }),
    ).toBeDisabled();
  });
});
