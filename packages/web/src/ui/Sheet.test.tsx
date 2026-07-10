import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Sheet } from './Sheet';

describe('Sheet', () => {
  it('releases focus from inside the sheet before closing (aria-hidden fix)', () => {
    const onOpenChange = vi.fn();
    render(
      <Sheet open onOpenChange={onOpenChange} title="T">
        <button>inside</button>
      </Sheet>,
    );
    const inside = screen.getByRole('button', { name: 'inside' });
    inside.focus();
    expect(document.activeElement).toBe(inside);
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    // Whatever path closed it, the focused element must have been blurred
    // by the time onOpenChange(false) fires.
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(document.activeElement).not.toBe(inside);
  });

  it('renders title and children when open', () => {
    render(
      <Sheet open onOpenChange={vi.fn()} title="Reject approval">
        <p>Reason required</p>
      </Sheet>,
    );
    expect(screen.getByText('Reject approval')).toBeInTheDocument();
    expect(screen.getByText('Reason required')).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    render(
      <Sheet open={false} onOpenChange={vi.fn()} title="Hidden">
        <p>Body</p>
      </Sheet>,
    );
    expect(screen.queryByText('Hidden')).toBeNull();
  });
});
