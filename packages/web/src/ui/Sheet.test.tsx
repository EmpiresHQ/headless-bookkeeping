import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Sheet } from './Sheet';

describe('Sheet', () => {
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
    const views = () => ({
      form: screen.getByRole('radio', { name: 'Form' }),
      source: screen.getByRole('radio', { name: 'Source document' }),
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
        fireEvent.click(views().source);
        expect(views().source).toBeChecked();
        expect(pane('source')).not.toHaveClass('invisible');
        expect(pane('form')).toHaveClass('invisible');
        fireEvent.click(views().form);
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
      fireEvent.click(views().source);
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
      fireEvent.click(views().source);
      fireEvent.click(views().form);
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
      expect(screen.queryByRole('radiogroup')).toBeNull();
      expect(document.querySelector('[data-sheet-pane]')).toBeNull();
    });
  });
  describe('explicit Close (issue #267)', () => {
    const closeButton = () =>
      within(screen.getByRole('dialog', { name: 'New expense' })).getByRole(
        'button',
        { name: 'Close' },
      );

    it('is a named type=button control that closes a clean sheet', () => {
      const onOpenChange = vi.fn();
      render(
        <Sheet open onOpenChange={onOpenChange} title="New expense">
          <p>Body</p>
        </Sheet>,
      );
      expect(closeButton()).toHaveAttribute('type', 'button');
      expect(closeButton()).toHaveAttribute('data-vaul-no-drag');
      fireEvent.click(closeButton());
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('never submits a form in the sheet', () => {
      const onSubmit = vi.fn((e: { preventDefault: () => void }) =>
        e.preventDefault(),
      );
      render(
        <Sheet open onOpenChange={vi.fn()} title="New expense">
          <form onSubmit={onSubmit}>
            <input aria-label="Amount" />
          </form>
        </Sheet>,
      );
      fireEvent.click(closeButton());
      fireEvent.keyDown(screen.getByLabelText('Amount'), { key: 'Enter' });
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('is disabled while a save is in flight; the sheet stays', () => {
      const onOpenChange = vi.fn();
      render(
        <Sheet open busy onOpenChange={onOpenChange} title="New expense">
          <p>Body</p>
        </Sheet>,
      );
      expect(closeButton()).toBeDisabled();
      fireEvent.click(closeButton());
      expect(onOpenChange).not.toHaveBeenCalled();
    });

    it('asks a dirty form first: Keep stays, Discard closes', async () => {
      let answer: (ok: boolean) => void = () => undefined;
      const guard = {
        isDirty: vi.fn(() => true),
        confirmDiscard: vi.fn(() => new Promise<boolean>((r) => (answer = r))),
      };
      const onOpenChange = vi.fn();
      render(
        <Sheet
          open
          onOpenChange={onOpenChange}
          title="New expense"
          guard={guard}
        >
          <p>Body</p>
        </Sheet>,
      );
      fireEvent.click(closeButton());
      expect(guard.confirmDiscard).toHaveBeenCalledTimes(1);
      await act(async () => answer(false));
      expect(onOpenChange).not.toHaveBeenCalled();

      fireEvent.click(closeButton());
      await act(async () => answer(true));
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('a late discard never closes a newer open generation', async () => {
      let answer: (ok: boolean) => void = () => undefined;
      const guard = {
        isDirty: () => true,
        confirmDiscard: () => new Promise<boolean>((r) => (answer = r)),
      };
      const onOpenChange = vi.fn();
      const view = (open: boolean) => (
        <Sheet
          open={open}
          onOpenChange={onOpenChange}
          title="New expense"
          guard={guard}
        >
          <p>Body</p>
        </Sheet>
      );
      const { rerender } = render(view(true));
      fireEvent.click(closeButton());
      // Closed another way and reopened before the question is answered.
      rerender(view(false));
      rerender(view(true));
      await act(async () => answer(true));
      expect(onOpenChange).not.toHaveBeenCalled();
    });

    it('stays reachable in both Form and Source views', () => {
      render(
        <Sheet
          open
          onOpenChange={vi.fn()}
          title="New expense"
          source={<p>SOURCE VIEW</p>}
        >
          <p>Body</p>
        </Sheet>,
      );
      fireEvent.click(screen.getByRole('radio', { name: 'Source document' }));
      expect(closeButton()).toBeVisible();
      expect(closeButton().closest('[data-sheet-pane]')).toBeNull();
    });
  });

  describe('viewport restore (issue #362)', () => {
    // jsdom has no layout or visualViewport: model the two viewports and
    // the drawer's box as the browser computes it — its natural height, or
    // vaul's inline height, capped by `max-h-[92vh]`.
    const NATURAL = 668.5;
    let vv: EventTarget & {
      height: number;
      scale: number;
      offsetTop: number;
      offsetLeft: number;
    };
    let restore: () => void;
    const dialog = () => screen.getByRole('dialog');
    // A source sheet is `h-[92vh]`: vaul's inline height replaces it.
    const boxHeight = (el: HTMLElement) => {
      const inline = parseFloat(el.style.height);
      const cap = window.innerHeight * 0.92;
      if (el.querySelector('[data-sheet-pane]')) {
        return Number.isNaN(inline) ? cap : inline;
      }
      return Math.min(Number.isNaN(inline) ? NATURAL : inline, cap);
    };
    // A resize as the browser delivers it: window first (vaul re-registers
    // its visualViewport listener on every window resize, landing it after
    // the sheet's own), then the visual viewport, then a frame.
    async function viewport(
      innerHeight: number,
      visual: Partial<{
        height: number;
        scale: number;
        offsetTop: number;
        offsetLeft: number;
      }> = {},
    ) {
      await act(async () => {
        const layoutChanged = window.innerHeight !== innerHeight;
        Object.defineProperty(window, 'innerHeight', {
          configurable: true,
          value: innerHeight,
        });
        Object.assign(vv, {
          height: innerHeight,
          scale: 1,
          offsetTop: 0,
          offsetLeft: 0,
          ...visual,
        });
        if (layoutChanged) window.dispatchEvent(new Event('resize'));
        await new Promise((r) => setTimeout(r, 0));
        vv.dispatchEvent(new Event('resize'));
        await new Promise((r) => requestAnimationFrame(r));
      });
    }
    function setup() {
      const inner = Object.getOwnPropertyDescriptor(window, 'innerHeight');
      const rect = vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockImplementation(function (this: HTMLElement) {
          if (this.getAttribute('role') !== 'dialog') return new DOMRect();
          // Fixed at `bottom` (vaul's inline lift, else 0).
          const h = boxHeight(this);
          const bottom = parseFloat(this.style.bottom) || 0;
          return new DOMRect(0, window.innerHeight - bottom - h, 390, h);
        });
      vv = Object.assign(new EventTarget(), {
        height: 844,
        scale: 1,
        offsetTop: 0,
        offsetLeft: 0,
      });
      Object.defineProperty(window, 'visualViewport', {
        configurable: true,
        value: vv,
      });
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: 844,
      });
      restore = () => {
        rect.mockRestore();
        delete (window as { visualViewport?: unknown }).visualViewport;
        if (inner) Object.defineProperty(window, 'innerHeight', inner);
      };
    }
    function renderSheet(source?: ReactNode) {
      render(
        <Sheet open onOpenChange={vi.fn()} title="New expense" source={source}>
          <input aria-label="Gross" />
        </Sheet>,
      );
    }

    it('a layout shrink then restore gives the sheet its full height back, keeping focus and value', async () => {
      setup();
      try {
        renderSheet();
        const gross = screen.getByLabelText('Gross') as HTMLInputElement;
        fireEvent.change(gross, { target: { value: '123.45' } });
        gross.focus();
        expect(boxHeight(dialog())).toBe(NATURAL);
        for (let i = 0; i < 3; i++) {
          await viewport(430);
          expect(boxHeight(dialog())).toBeCloseTo(430 * 0.92);
          await viewport(844);
          expect(boxHeight(dialog())).toBe(NATURAL);
          expect(parseFloat(dialog().style.bottom || '0')).toBe(0);
        }
        expect(document.activeElement).toBe(gross);
        expect(gross.value).toBe('123.45');
      } finally {
        restore();
      }
    });

    it('keeps vaul lifting the sheet over a keyboard, then restores it when the keyboard goes', async () => {
      setup();
      try {
        renderSheet();
        screen.getByLabelText('Gross').focus();
        await viewport(844, { height: 508 });
        expect(dialog().style.bottom).toBe('336px');
        expect(dialog().style.height).not.toBe('');
        await viewport(844);
        expect(boxHeight(dialog())).toBe(NATURAL);
        expect(parseFloat(dialog().style.bottom || '0')).toBe(0);
      } finally {
        restore();
      }
    });

    it('a source sheet gets its 92vh back after a layout shrink and restore', async () => {
      setup();
      try {
        renderSheet(<p>SOURCE VIEW</p>);
        screen.getByLabelText('Gross').focus();
        const full = boxHeight(dialog());
        await viewport(430);
        await viewport(844);
        expect(boxHeight(dialog())).toBeCloseTo(full);
        expect(screen.getByText('SOURCE VIEW')).toBeInTheDocument();
      } finally {
        restore();
      }
    });

    it('without a focused field a layout resize leaves the sheet to CSS', async () => {
      setup();
      try {
        renderSheet();
        await viewport(430);
        await viewport(844);
        expect(dialog().style.height).toBe('');
        expect(boxHeight(dialog())).toBe(NATURAL);
      } finally {
        restore();
      }
    });

    it('leaves vaul in charge while the visual viewport is panned', async () => {
      setup();
      try {
        renderSheet();
        screen.getByLabelText('Gross').focus();
        await viewport(844, { height: 508 });
        // Same size as the page again but still scrolled away from it:
        // vaul's own write stands.
        await viewport(844, { offsetTop: 40 });
        expect(dialog().style.height).not.toBe('');
        await viewport(844, { offsetLeft: 30 });
        expect(dialog().style.height).not.toBe('');
        await viewport(844);
        expect(boxHeight(dialog())).toBe(NATURAL);
      } finally {
        restore();
      }
    });

    // A resize whose re-check frame is still queued when the sheet closes
    // (or closes and opens again): the keyboard went down meanwhile, so the
    // frame would see an unobscured viewport.
    function queueFrameUnderKeyboard(gross: HTMLElement) {
      gross.focus();
      act(() => {
        vv.height = 508;
        vv.dispatchEvent(new Event('resize'));
      });
      const old = dialog();
      expect(old.style.bottom).toBe('336px');
      vv.height = 844;
      return old;
    }
    const frame = () =>
      act(() => new Promise((r) => requestAnimationFrame(() => r(null))));

    it('a queued frame never touches a panel that closed', async () => {
      setup();
      try {
        const { rerender } = render(
          <Sheet open onOpenChange={vi.fn()} title="New expense">
            <input aria-label="Gross" />
          </Sheet>,
        );
        const old = queueFrameUnderKeyboard(screen.getByLabelText('Gross'));
        const written = old.getAttribute('style');
        rerender(
          <Sheet open={false} onOpenChange={vi.fn()} title="New expense">
            <input aria-label="Gross" />
          </Sheet>,
        );
        await frame();
        expect(old.getAttribute('style')).toBe(written);
      } finally {
        restore();
      }
    });

    it("a queued frame never targets the next open's panel", async () => {
      setup();
      try {
        const sheet = (open: boolean) => (
          <Sheet open={open} onOpenChange={vi.fn()} title="New expense">
            <input aria-label="Gross" />
          </Sheet>
        );
        const { rerender } = render(sheet(true));
        const old = queueFrameUnderKeyboard(screen.getByLabelText('Gross'));
        rerender(sheet(false));
        rerender(sheet(true));
        const next = dialog();
        expect(next).not.toBe(old);
        // Whatever vaul keeps on the new panel is its own business until an
        // event for it arrives.
        next.style.height = '500px';
        await frame();
        expect(next.style.height).toBe('500px');
      } finally {
        restore();
      }
    });

    // Issue #295 (QA-002 re-run): rotating with the keyboard up. vaul
    // floors the panel height at `visualViewport.height - top`, and the top
    // it reads right after a layout change is the portrait lift seen in the
    // landscape box — far above the screen — so the panel came out taller
    // than the space left over the keyboard, Close and the first fields
    // pushed above the screen until the keyboard went away.
    it('rotating with the keyboard up keeps the panel top on screen', async () => {
      setup();
      try {
        renderSheet();
        const gross = screen.getByLabelText('Gross') as HTMLInputElement;
        fireEvent.change(gross, { target: { value: '45.67' } });
        gross.focus();
        await viewport(844, { height: 508 }); // portrait, keyboard up
        expect(dialog().getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
        await viewport(390, { height: 200 }); // landscape, keyboard up
        const land = dialog().getBoundingClientRect();
        expect(dialog().style.bottom).toBe('190px');
        expect(land.top).toBeGreaterThanOrEqual(0);
        expect(land.bottom).toBeLessThanOrEqual(200);
        await viewport(844, { height: 508 }); // portrait again
        // Full use of the room over the keyboard again, not the landscape
        // height: vaul's 26px gap at the top, as on a first lift.
        const port = dialog().getBoundingClientRect();
        expect(port.top).toBeCloseTo(26);
        expect(port.bottom).toBe(508);
        await viewport(844); // keyboard hidden
        expect(boxHeight(dialog())).toBe(NATURAL);
        expect(parseFloat(dialog().style.bottom || '0')).toBe(0);
        expect(document.activeElement).toBe(gross);
        expect(gross.value).toBe('45.67');
      } finally {
        restore();
      }
    });

    it('a short panel keeps its own height when fitted after a rotation', async () => {
      setup();
      try {
        render(
          <Sheet open onOpenChange={vi.fn()} title="Reason">
            <input aria-label="Gross" />
          </Sheet>,
        );
        const natural = vi
          .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
          .mockImplementation(function (this: HTMLElement) {
            if (this.getAttribute('role') !== 'dialog') return new DOMRect();
            const inline = parseFloat(this.style.height);
            const h = Math.min(
              Number.isNaN(inline) ? 300 : inline,
              window.innerHeight * 0.92,
            );
            const bottom = parseFloat(this.style.bottom) || 0;
            return new DOMRect(0, window.innerHeight - bottom - h, 390, h);
          });
        screen.getByLabelText('Gross').focus();
        await viewport(844, { height: 508 });
        await viewport(390, { height: 200 });
        expect(dialog().getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
        await viewport(844, { height: 508 });
        expect(dialog().getBoundingClientRect().height).toBe(300);
        natural.mockRestore();
      } finally {
        restore();
      }
    });

    it('leaves a lifted panel that fits to vaul', async () => {
      setup();
      try {
        renderSheet();
        screen.getByLabelText('Gross').focus();
        await viewport(844, { height: 508 });
        const lifted = dialog().getAttribute('style');
        await viewport(844, { height: 508 });
        expect(dialog().getAttribute('style')).toBe(lifted);
      } finally {
        restore();
      }
    });

    it('leaves vaul in charge while pinch-zoomed', async () => {
      setup();
      try {
        renderSheet();
        screen.getByLabelText('Gross').focus();
        await viewport(844, { height: 422, scale: 2 });
        expect(dialog().style.height).not.toBe('');
        expect(dialog().style.bottom).toBe('422px');
      } finally {
        restore();
      }
    });
  });
});
