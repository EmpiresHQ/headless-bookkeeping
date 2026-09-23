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

  describe('with a source pane (issue #257)', () => {
    const tabs = () => ({
      form: screen.getByRole('tab', { name: 'Form' }),
      source: screen.getByRole('tab', { name: 'Source document' }),
    });
    const pane = (name: 'form' | 'source') =>
      document.querySelector(`[data-sheet-pane="${name}"]`) as HTMLElement;

    function renderWithSource(
      props: Partial<Parameters<typeof Sheet>[0]> = {},
    ) {
      const onOpenChange = vi.fn();
      render(
        <Sheet
          open
          onOpenChange={onOpenChange}
          title="Classify"
          source={<p>SOURCE VIEW</p>}
          {...props}
        >
          <input aria-label="Amount" />
        </Sheet>,
      );
      return onOpenChange;
    }

    it('toggles Form/Source without unmounting either: input, form scroll and source stay', () => {
      const guard = { isDirty: vi.fn(() => true), confirmDiscard: vi.fn() };
      const onOpenChange = renderWithSource({ guard });
      const amount = screen.getByLabelText('Amount') as HTMLInputElement;
      fireEvent.change(amount, { target: { value: '48.20' } });
      pane('form').scrollTop = 320;
      const source = screen.getByText('SOURCE VIEW');

      expect(pane('form')).not.toHaveClass('invisible');
      expect(pane('source')).toHaveClass('invisible');
      for (let i = 0; i < 3; i++) {
        fireEvent.click(tabs().source);
        expect(tabs().source).toHaveAttribute('aria-selected', 'true');
        expect(pane('source')).not.toHaveClass('invisible');
        expect(pane('form')).toHaveClass('invisible');
        fireEvent.click(tabs().form);
        expect(pane('form')).not.toHaveClass('invisible');
      }
      // Same nodes, same value, same scroll: nothing was remounted.
      expect(screen.getByLabelText('Amount')).toBe(amount);
      expect(amount.value).toBe('48.20');
      expect(pane('form').scrollTop).toBe(320);
      expect(screen.getByText('SOURCE VIEW')).toBe(source);
      // Switching views is not a dismissal: no close, no discard question.
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(guard.confirmDiscard).not.toHaveBeenCalled();
    });

    it('switching stays available while a save is in flight; dismiss is still refused', () => {
      const onOpenChange = renderWithSource({ busy: true });
      fireEvent.click(tabs().source);
      expect(pane('source')).not.toHaveClass('invisible');
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: 'Escape',
      });
      expect(onOpenChange).not.toHaveBeenCalled();
    });

    it('a dirty form still asks before Escape closes it after viewing the source', async () => {
      const guard = {
        isDirty: vi.fn(() => true),
        confirmDiscard: vi.fn(async () => false),
      };
      const onOpenChange = renderWithSource({ guard });
      fireEvent.click(tabs().source);
      fireEvent.click(tabs().form);
      fireEvent.keyDown(screen.getByLabelText('Amount'), { key: 'Escape' });
      await Promise.resolve();
      expect(guard.confirmDiscard).toHaveBeenCalledTimes(1);
      expect(onOpenChange).not.toHaveBeenCalled();
    });

    it('the source pane opts out of drawer drag (pan/zoom never swipes the sheet away)', () => {
      renderWithSource();
      expect(pane('source')).toHaveAttribute('data-vaul-no-drag');
      expect(pane('form')).not.toHaveAttribute('data-vaul-no-drag');
    });

    it('without a source the sheet is unchanged (no switch, no panes)', () => {
      render(
        <Sheet open onOpenChange={vi.fn()} title="Plain">
          <p>Body</p>
        </Sheet>,
      );
      expect(screen.queryByRole('tablist')).toBeNull();
      expect(document.querySelector('[data-sheet-pane]')).toBeNull();
    });
  });
});
