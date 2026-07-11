import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppToaster, toastUndo } from './toast';

describe('toastUndo', () => {
  it('shows message with an Undo action', async () => {
    render(<AppToaster />);
    act(() => {
      toastUndo('Approved #214', vi.fn());
    });
    expect(await screen.findByText('Approved #214')).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Undo' }),
    ).toBeInTheDocument();
  });
});
