import { act, fireEvent, render, screen, within } from '@testing-library/react';
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
});
