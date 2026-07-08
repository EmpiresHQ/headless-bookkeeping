import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  it('fires onConfirm and renders destructive style', async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Delete statement?"
        body="This cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
    act(() => {
      screen.getByRole('button', { name: 'Delete' }).click();
    });
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
