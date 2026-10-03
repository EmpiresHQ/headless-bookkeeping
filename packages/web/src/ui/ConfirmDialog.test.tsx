import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (HTMLElement.prototype as { scrollIntoView?: unknown })
      .scrollIntoView;
  });

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

  // Issue #366: a long dialog scrolls inside itself. It opens at the top
  // (Cancel focused without scrolling, the question first), but focus the
  // trap wraps around with Tab/Shift+Tab — which Radix moves with
  // preventScroll — must be brought into view, never left off-screen.
  it('opens without scrolling and brings trap-wrapped focus into view', async () => {
    const user = userEvent.setup();
    const scrolled: Element[] = [];
    const scrollIntoView = vi.fn(function (this: Element) {
      scrolled.push(this);
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Delete this entity?"
        body={'Very long name '.repeat(80)}
        confirmLabel="Delete entity"
        destructive
        onConfirm={onConfirm}
      />,
    );
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Delete entity' });
    await vi.waitFor(() => expect(cancel).toHaveFocus());
    expect(scrollIntoView).not.toHaveBeenCalled();

    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
    expect(scrolled[scrolled.length - 1]).toBe(confirm);
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' });

    await user.tab();
    expect(cancel).toHaveFocus();
    expect(scrolled[scrolled.length - 1]).toBe(cancel);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  // A Tab that moved nothing (both actions disabled while busy, or a key
  // still down when the dialog closed) must not linger: the next open
  // still starts at the top, not scrolled down to Cancel.
  it('never lets a stale Tab scroll the next open', async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    const props = {
      onOpenChange: vi.fn(),
      title: 'Delete this entity?',
      body: 'Very long name '.repeat(80),
      confirmLabel: 'Delete entity',
      destructive: true,
      onConfirm: vi.fn(),
    };
    const { rerender } = render(<ConfirmDialog {...props} open busy />);
    const dialog = screen.getByRole('alertdialog');
    await user.tab();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    rerender(<ConfirmDialog {...props} open={false} />);
    await vi.waitFor(() =>
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(),
    );
    rerender(<ConfirmDialog {...props} open />);
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    await vi.waitFor(() => expect(cancel).toHaveFocus());
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
