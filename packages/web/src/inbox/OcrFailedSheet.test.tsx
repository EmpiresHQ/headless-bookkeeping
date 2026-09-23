import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  uploadDocument: vi.fn(),
  triageDocument: vi.fn(),
  completeDocument: vi.fn(),
  retryDocument: vi.fn(),
}));

import * as api from '../api';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';
import { OcrFailedSheet } from './OcrFailedSheet';

describe('OcrFailedSheet', () => {
  beforeEach(() => vi.clearAllMocks());

  function renderSheet(onReplaced = vi.fn(), onRetried = vi.fn()) {
    render(
      <UnsavedChangesProvider onUnauthorized={() => undefined}>
        <OcrFailedSheet
          documentId={12}
          open
          onOpenChange={() => undefined}
          onReplaced={onReplaced}
          onRetried={onRetried}
        />
      </UnsavedChangesProvider>,
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

  const upload99 = () =>
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
  const choose = (f: File) =>
    fireEvent.change(screen.getByLabelText('Replacement file'), {
      target: { files: [f] },
    });
  const selected = () => screen.getByRole('region', { name: 'Selected file' });

  it('a chosen replacement is checked locally first: nothing is sent, a cancelled picker keeps it, Remove clears it (#293)', async () => {
    renderSheet();
    const f = new File(['x'], 'better.jpg', { type: 'image/jpeg' });
    choose(f);
    expect(selected()).toHaveTextContent('better.jpg');
    expect(selected()).toHaveTextContent('selected on this device');
    expect(
      screen.getByRole('img', { name: 'Selected file better.jpg' }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Replacement file'), {
      target: { files: [] },
    });
    expect(selected()).toHaveTextContent('better.jpg');
    expect(
      screen.getByRole('button', { name: 'Upload replacement' }),
    ).toBeEnabled();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(api.uploadDocument).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(
      screen.getByRole('button', { name: 'Upload replacement' }),
    ).toBeDisabled();
    expect(screen.queryByRole('region', { name: 'Selected file' })).toBeNull();
  });

  it('replacement stored but not processed: the header names it, and Finish resumes without a second upload (#293)', async () => {
    upload99();
    vi.mocked(api.triageDocument)
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce({
        kind: 'expense',
        document_id: 99,
        expense_id: 7,
      });
    vi.mocked(api.completeDocument).mockResolvedValue({
      id: 12,
      status: 'processed',
    });
    const { onReplaced } = renderSheet();
    const f = new File(['x'], 'better.jpg', { type: 'image/jpeg' });
    choose(f);
    fireEvent.click(screen.getByRole('button', { name: 'Upload replacement' }));
    const finish = await screen.findByRole('button', {
      name: 'Finish replacement',
    });
    expect(selected()).toHaveTextContent('already uploaded as document #99');
    fireEvent.click(finish);
    await waitFor(() => expect(onReplaced).toHaveBeenCalled());
    expect(api.uploadDocument).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.uploadDocument).mock.calls[0][0]).toBe(f);
    expect(api.triageDocument).toHaveBeenCalledTimes(2);
    expect(api.completeDocument).toHaveBeenCalledTimes(1);
  });

  it('archive of the original failed: Finish only archives — no re-upload, no re-processing (#293)', async () => {
    upload99();
    vi.mocked(api.triageDocument).mockResolvedValue({
      kind: 'expense',
      document_id: 99,
      expense_id: 7,
    });
    vi.mocked(api.completeDocument)
      .mockRejectedValueOnce(new Error('502'))
      .mockResolvedValueOnce({ id: 12, status: 'processed' });
    const { onReplaced } = renderSheet();
    choose(new File(['x'], 'better.jpg', { type: 'image/jpeg' }));
    fireEvent.click(screen.getByRole('button', { name: 'Upload replacement' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Finish replacement' }),
    );
    await waitFor(() => expect(onReplaced).toHaveBeenCalled());
    expect(api.uploadDocument).toHaveBeenCalledTimes(1);
    expect(api.triageDocument).toHaveBeenCalledTimes(1);
    expect(api.completeDocument).toHaveBeenCalledTimes(2);
  });

  it('an unconfirmed replacement upload keeps the file without claiming where it is (#293)', async () => {
    vi.mocked(api.uploadDocument).mockRejectedValueOnce(new Error('offline'));
    renderSheet();
    choose(new File(['x'], 'better.jpg', { type: 'image/jpeg' }));
    fireEvent.click(screen.getByRole('button', { name: 'Upload replacement' }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Upload replacement' }),
      ).toBeEnabled(),
    );
    expect(selected()).toHaveTextContent('selected on this device');
  });

  it('closing the sheet or ending the session drops the local preview and revokes its URL (#293)', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:chosen-1');
    const ui = (open: boolean) => (
      <UnsavedChangesProvider onUnauthorized={() => undefined}>
        <OcrFailedSheet
          documentId={12}
          open={open}
          onOpenChange={() => undefined}
          onReplaced={vi.fn()}
          onRetried={vi.fn()}
        />
      </UnsavedChangesProvider>
    );
    const { rerender, unmount } = render(ui(true));
    choose(new File(['x'], 'better.jpg', { type: 'image/jpeg' }));
    expect(screen.getByRole('img', { name: /Selected file/ })).toHaveAttribute(
      'src',
      'blob:chosen-1',
    );
    rerender(ui(false));
    await waitFor(() =>
      expect(screen.queryByRole('img', { name: /Selected file/ })).toBeNull(),
    );
    expect(revoke).toHaveBeenCalledWith('blob:chosen-1');
    // Reopened: the choice is still the operator's (not silently dropped),
    // shown from a fresh URL; the session ending unmounts and revokes it.
    rerender(ui(true));
    await screen.findByRole('img', { name: /Selected file/ });
    revoke.mockClear();
    unmount();
    expect(revoke).toHaveBeenCalledWith('blob:chosen-1');
    vi.restoreAllMocks();
  });
});
