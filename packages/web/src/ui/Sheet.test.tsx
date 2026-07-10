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

  it('releases focus from the outside trigger when mounted open (open-edge aria-hidden fix)', () => {
    // The trigger that opened the sheet keeps DOM focus (vaul prevents
    // Radix's open-autofocus), so Radix aria-hides the app root around a
    // still-focused element and the browser warns at OPEN. Epoch-keyed
    // sheets mount already open — the mount must blur the outside trigger.
    render(<button>trigger</button>);
    const trigger = screen.getByRole('button', { name: 'trigger' });
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    render(
      <Sheet open onOpenChange={vi.fn()} title="T">
        <p>Body</p>
      </Sheet>,
    );
    expect(document.activeElement).not.toBe(trigger);
  });

  it('releases outside focus when open flips true (always-mounted sheets)', () => {
    const { rerender } = render(
      <>
        <button>trigger</button>
        <Sheet open={false} onOpenChange={vi.fn()} title="T">
          <p>Body</p>
        </Sheet>
      </>,
    );
    const trigger = screen.getByRole('button', { name: 'trigger' });
    trigger.focus();
    rerender(
      <>
        <button>trigger</button>
        <Sheet open onOpenChange={vi.fn()} title="T">
          <p>Body</p>
        </Sheet>
      </>,
    );
    expect(document.activeElement).not.toBe(trigger);
  });

  it('does not steal focus when mounted closed', () => {
    render(<button>search</button>);
    const search = screen.getByRole('button', { name: 'search' });
    search.focus();
    render(
      <Sheet open={false} onOpenChange={vi.fn()} title="Hidden">
        <p>Body</p>
      </Sheet>,
    );
    expect(document.activeElement).toBe(search);
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
