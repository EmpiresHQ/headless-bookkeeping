import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { StrictMode, useRef, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createModalLayerRegistry,
  ModalLayerContext,
} from '../lib/modalLayers';
import {
  UnsavedChangesProvider,
  useUnsavedChanges,
} from '../lib/unsavedChanges';
import { ConfirmDialog } from './ConfirmDialog';
import { Sheet } from './Sheet';

/** Issue #268: initial focus and meaningful return, through Radix's own
 *  close lifecycle (unmount → FocusScope close-autofocus task). */

// Radix FocusScope dispatches close-autofocus in a task after unmount.
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });

const closeIn = (name: string) =>
  within(screen.getByRole('dialog', { name })).getByRole('button', {
    name: 'Close',
  });

// aria-hidden ordering: nothing focused may ever sit inside a subtree the
// modal marks aria-hidden (the browser's "Blocked aria-hidden" warning).
let ariaViolations: string[] = [];
const realSetAttribute = Element.prototype.setAttribute;
beforeEach(() => {
  ariaViolations = [];
  vi.spyOn(Element.prototype, 'setAttribute').mockImplementation(function (
    this: Element,
    name: string,
    value: string,
  ) {
    const active = document.activeElement;
    if (
      name === 'aria-hidden' &&
      value === 'true' &&
      active !== null &&
      active !== document.body &&
      this.contains(active)
    ) {
      ariaViolations.push(active.textContent ?? active.tagName);
    }
    return realSetAttribute.call(this, name, value);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

function Screen({
  fallback = false,
  children,
}: {
  fallback?: boolean;
  children?: (p: {
    close: () => void;
    setGone: (g: boolean) => void;
  }) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [gone, setGone] = useState(false);
  const status = useRef<HTMLParagraphElement>(null);
  return (
    <>
      {!gone && (
        <button type="button" onClick={() => setOpen(true)}>
          Open form
        </button>
      )}
      <p ref={status} tabIndex={-1}>
        STATUS
      </p>
      <button type="button">Elsewhere</button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title="Form"
        returnFocusFallback={fallback ? status : undefined}
      >
        <input aria-label="Amount" />
        {children?.({ close: () => setOpen(false), setGone })}
      </Sheet>
    </>
  );
}

describe('Sheet focus (issue #268)', () => {
  it('keyboard open: focus starts on Close (never an editable field); the trigger was released before aria-hidden', async () => {
    render(<Screen />);
    const trigger = screen.getByRole('button', { name: 'Open form' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(await screen.findByRole('dialog', { name: 'Form' })).toBeVisible();
    expect(document.activeElement).toBe(closeIn('Form'));
    expect(document.activeElement).not.toBe(screen.getByLabelText('Amount'));
    expect(ariaViolations).toEqual([]);
  });

  it('Escape returns focus to the trigger after the close lifecycle', async () => {
    render(<Screen />);
    const trigger = screen.getByRole('button', { name: 'Open form' });
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole('dialog', { name: 'Form' });
    fireEvent.keyDown(screen.getByLabelText('Amount'), { key: 'Escape' });
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(ariaViolations).toEqual([]);
  });

  it('the explicit Close button returns focus to the trigger', async () => {
    render(<Screen />);
    const trigger = screen.getByRole('button', { name: 'Open form' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    await settle();
    expect(document.activeElement).toBe(trigger);
  });

  it('a direct open-prop flip from inside the content (success close) returns to the trigger', async () => {
    render(
      <Screen>
        {({ close }) => (
          <button type="button" onClick={close}>
            Save
          </button>
        )}
      </Screen>,
    );
    const trigger = screen.getByRole('button', { name: 'Open form' });
    trigger.focus();
    fireEvent.click(trigger);
    const save = await screen.findByRole('button', { name: 'Save' });
    save.focus();
    fireEvent.click(save);
    await settle();
    expect(document.activeElement).toBe(trigger);
    expect(ariaViolations).toEqual([]);
  });

  it('pointer/tap activation that never focused the trigger still returns to it', async () => {
    render(<Screen />);
    const trigger = screen.getByRole('button', { name: 'Open form' });
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(trigger); // no focus: platform-dependent tap behavior
    await screen.findByRole('dialog', { name: 'Form' });
    fireEvent.click(closeIn('Form'));
    await settle();
    expect(document.activeElement).toBe(trigger);
  });

  it('a tap that does not focus its button beats an older focused field', async () => {
    render(
      <>
        <input aria-label="Search" />
        <Screen />
      </>,
    );
    const search = screen.getByLabelText('Search');
    search.focus(); // stays focused: the platform does not move focus on tap
    const trigger = screen.getByRole('button', { name: 'Open form' });
    fireEvent.click(trigger);
    await screen.findByRole('dialog', { name: 'Form' });
    fireEvent.click(closeIn('Form'));
    await settle();
    expect(document.activeElement).toBe(trigger);
  });

  it('a late close event of an old generation never restores or retires the newer one (same instance)', async () => {
    let setOpen: (o: boolean) => void = () => undefined;
    function Reopen() {
      const [open, set] = useState(false);
      setOpen = set;
      return (
        <>
          <button type="button" onClick={() => set(true)}>
            Open A
          </button>
          <button type="button" onClick={() => set(true)}>
            Open B
          </button>
          <Sheet open={open} onOpenChange={set} title="Same">
            <p>body</p>
          </Sheet>
        </>
      );
    }
    render(<Reopen />);
    const a = screen.getByRole('button', { name: 'Open A' });
    const b = screen.getByRole('button', { name: 'Open B' });
    a.focus();
    fireEvent.click(a);
    await screen.findByRole('dialog', { name: 'Same' });
    // Close, then reopen from B before gen 1's close event (a task later).
    act(() => setOpen(false));
    b.focus();
    fireEvent.click(b);
    expect(screen.getByRole('dialog', { name: 'Same' })).toBeVisible();
    await settle();
    // Gen 1's late event neither pulled focus to A nor retired gen 2.
    expect(document.activeElement).toBe(closeIn('Same'));
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    await settle();
    expect(document.activeElement).toBe(b);
  });

  it("an unrelated open after the closing task never inherits the closing sheet's return", async () => {
    let setB: (o: boolean) => void = () => undefined;
    function Pair() {
      const [a, setA] = useState(false);
      const [b, set] = useState(false);
      setB = set;
      return (
        <>
          <button type="button" onClick={() => setA(true)}>
            Open A
          </button>
          <Sheet open={a} onOpenChange={setA} title="A">
            <button type="button" onClick={() => setA(false)}>
              Done
            </button>
          </Sheet>
          <Sheet open={b} onOpenChange={set} title="B">
            <p>B</p>
          </Sheet>
        </>
      );
    }
    // A animates out (only A): Radix Presence reads the computed animation name and
    // waits for its animationend (jsdom computes no CSS animations).
    const realStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
      const real = realStyle(el, pseudo);
      if (el.getAttribute('role') !== 'dialog') return real;
      return new Proxy(real, {
        get: (t, k) =>
          k === 'animationName'
            ? el.getAttribute('data-state') === 'closed' &&
              el.textContent?.includes('Done') === true
              ? 'sheet-out'
              : 'none'
            : Reflect.get(t, k),
      });
    });
    render(<Pair />);
    const openA = screen.getByRole('button', { name: 'Open A' });
    openA.focus();
    fireEvent.click(openA);
    const a = await screen.findByRole('dialog', { name: 'A' });
    const done = screen.getByRole('button', { name: 'Done' });
    done.focus();
    fireEvent.click(done);
    expect(a).toBeInTheDocument(); // still exiting
    await settle(); // the closing task is over
    act(() => setB(true)); // programmatic, nothing focused
    await screen.findByRole('dialog', { name: 'B' });
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    await settle();
    expect(document.activeElement).not.toBe(openA);
    // A's own return still happens when A's exit ends.
    // jsdom has neither CSS.escape nor AnimationEvent.animationName.
    if (typeof globalThis.CSS?.escape !== 'function') {
      vi.stubGlobal('CSS', { escape: (v: string) => v });
    }
    const end = new Event('animationend');
    Object.defineProperty(end, 'animationName', { value: 'sheet-out' });
    act(() => {
      a.dispatchEvent(end);
    });
    await settle();
    expect(document.activeElement).toBe(openA);
  });

  it('a trigger removed by the action falls back to the explicit same-screen target', async () => {
    render(
      <Screen fallback>
        {({ close, setGone }) => (
          <button
            type="button"
            onClick={() => {
              setGone(true);
              close();
            }}
          >
            Finish
          </button>
        )}
      </Screen>,
    );
    const trigger = screen.getByRole('button', { name: 'Open form' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('button', { name: 'Finish' }));
    await settle();
    expect(screen.queryByRole('button', { name: 'Open form' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByText('STATUS'));
  });

  it('a disabled trigger is not a target; no fallback → focus is not moved anywhere arbitrary', async () => {
    function Disabling() {
      const [open, setOpen] = useState(false);
      const [done, setDone] = useState(false);
      return (
        <>
          <button type="button" disabled={done} onClick={() => setOpen(true)}>
            Open form
          </button>
          <Sheet open={open} onOpenChange={setOpen} title="Form">
            <button
              type="button"
              onClick={() => {
                setDone(true);
                setOpen(false);
              }}
            >
              Finish
            </button>
          </Sheet>
        </>
      );
    }
    render(<Disabling />);
    const trigger = screen.getByRole('button', { name: 'Open form' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('button', { name: 'Finish' }));
    await settle();
    expect(trigger).toBeDisabled();
    expect(document.activeElement).toBe(document.body);
  });

  it('route-changing completion: never restores the outgoing opener or fallback', async () => {
    render(
      <Screen fallback>
        {({ close }) => (
          <button
            type="button"
            onClick={() => {
              close();
              // The router commits the URL before a lazy destination renders.
              window.history.pushState(null, '', '/books/expenses/42');
            }}
          >
            Create
          </button>
        )}
      </Screen>,
    );
    const trigger = screen.getByRole('button', { name: 'Open form' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('button', { name: 'Create' }));
    await settle();
    // The old screen is still mounted (lazy chunk pending): untouched.
    expect(trigger).toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
  });

  it('never steals focus the user moved elsewhere before the late restore', async () => {
    render(<Screen />);
    const trigger = screen.getByRole('button', { name: 'Open form' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    // Unmounted, close-autofocus task not yet run: the user focuses on.
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    elsewhere.focus();
    await settle();
    expect(document.activeElement).toBe(elsewhere);
  });

  it('never restores under a newer layer (registry top)', async () => {
    const layers = createModalLayerRegistry();
    function Two() {
      const [a, setA] = useState(false);
      const [b, setB] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setA(true)}>
            Open A
          </button>
          <Sheet open={a} onOpenChange={setA} title="A">
            <button
              type="button"
              onClick={() => {
                setA(false);
                setB(true);
              }}
            >
              Go B
            </button>
          </Sheet>
          <Sheet open={b} onOpenChange={setB} title="B">
            <p>B body</p>
          </Sheet>
        </>
      );
    }
    render(
      <ModalLayerContext.Provider value={layers}>
        <Two />
      </ModalLayerContext.Provider>,
    );
    const trigger = screen.getByRole('button', { name: 'Open A' });
    trigger.focus();
    fireEvent.click(trigger);
    const go = await screen.findByRole('button', { name: 'Go B' });
    go.focus();
    fireEvent.click(go);
    await screen.findByRole('dialog', { name: 'B' });
    await settle();
    // A's late close-autofocus did not pull focus out of B.
    expect(document.activeElement).toBe(closeIn('B'));
    expect(layers.count()).toBe(1);
    expect(ariaViolations).toEqual([]);
    // B inherited A's return (A's row is gone): back to the trigger.
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    await settle();
    expect(document.activeElement).toBe(trigger);
  });

  it('StrictMode cleanup/replay keeps the opener (not an inside element)', async () => {
    render(
      <StrictMode>
        <Screen />
      </StrictMode>,
    );
    const trigger = screen.getByRole('button', { name: 'Open form' });
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole('dialog', { name: 'Form' });
    await settle();
    // The replayed FocusScope's close-autofocus never pulls focus out.
    expect(document.activeElement).toBe(closeIn('Form'));
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    await settle();
    expect(document.activeElement).toBe(trigger);
  });

  it('epoch-keyed sheets mounted open: opener captured at mount; reopen gets a fresh generation', async () => {
    function Keyed() {
      const [s, setS] = useState({ open: false, epoch: 0 });
      return (
        <>
          <button
            type="button"
            onClick={() => setS((p) => ({ open: true, epoch: p.epoch + 1 }))}
          >
            Open keyed
          </button>
          {s.epoch > 0 && (
            <Sheet
              key={s.epoch}
              open={s.open}
              onOpenChange={(o) => !o && setS((p) => ({ ...p, open: false }))}
              title="Keyed"
            >
              <input aria-label="Field" />
            </Sheet>
          )}
        </>
      );
    }
    render(<Keyed />);
    const trigger = screen.getByRole('button', { name: 'Open keyed' });
    for (let i = 0; i < 2; i++) {
      trigger.focus();
      fireEvent.click(trigger);
      await screen.findByRole('dialog', { name: 'Keyed' });
      expect(document.activeElement).toBe(closeIn('Keyed'));
      fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
      await settle();
      expect(document.activeElement).toBe(trigger);
    }
  });

  it('busy at open: focus starts on the content (Close is disabled)', async () => {
    render(
      <Sheet open busy onOpenChange={vi.fn()} title="Busy">
        <input aria-label="Amount" />
      </Sheet>,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Busy' });
    expect(document.activeElement).toBe(dialog);
  });

  it('a busy veto keeps focus inside the sheet (never the background)', async () => {
    const onOpenChange = vi.fn();
    const view = (busy: boolean) => (
      <>
        <button type="button">Background</button>
        <Sheet open busy={busy} onOpenChange={onOpenChange} title="Saving">
          <button type="button" disabled={busy}>
            Save
          </button>
        </Sheet>
      </>
    );
    const { rerender } = render(view(false));
    const save = await screen.findByRole('button', { name: 'Save' });
    save.focus();
    rerender(view(true)); // the save disables its own button
    save.blur(); // what the browser does to a focused control disabled
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Saving' });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  describe('dirty dismiss (Keep / Discard)', () => {
    function Guarded() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open form
          </button>
          <GuardedSheet open={open} onOpenChange={setOpen} />
        </>
      );
    }
    function GuardedSheet({
      open,
      onOpenChange,
    }: {
      open: boolean;
      onOpenChange: (o: boolean) => void;
    }) {
      const [gross, setGross] = useState('');
      const guard = useUnsavedChanges({
        label: 'New expense',
        active: open,
        values: gross,
        baseline: '',
      });
      return (
        <Sheet
          open={open}
          onOpenChange={onOpenChange}
          title="New expense"
          guard={guard}
        >
          <input
            aria-label="Gross"
            value={gross}
            onChange={(e) => setGross(e.target.value)}
          />
        </Sheet>
      );
    }
    const mount = () =>
      render(
        <UnsavedChangesProvider onUnauthorized={() => undefined}>
          <Guarded />
        </UnsavedChangesProvider>,
      );

    it('Keep editing returns focus to the field the question was asked from', async () => {
      mount();
      const trigger = screen.getByRole('button', { name: 'Open form' });
      trigger.focus();
      fireEvent.click(trigger);
      const gross = await screen.findByLabelText('Gross');
      gross.focus();
      fireEvent.change(gross, { target: { value: '12' } });
      fireEvent.keyDown(gross, { key: 'Escape' });
      const keep = await screen.findByRole('button', { name: 'Keep editing' });
      expect(document.activeElement).toBe(keep);
      fireEvent.click(keep);
      await settle();
      expect(screen.getByRole('dialog', { name: 'New expense' })).toBeVisible();
      expect(document.activeElement).toBe(gross);
      expect(ariaViolations).toEqual([]);
    });

    it('Keep editing after the Close button returns to Close', async () => {
      mount();
      const trigger = screen.getByRole('button', { name: 'Open form' });
      trigger.focus();
      fireEvent.click(trigger);
      fireEvent.change(await screen.findByLabelText('Gross'), {
        target: { value: '12' },
      });
      closeIn('New expense').focus();
      fireEvent.click(closeIn('New expense'));
      fireEvent.click(
        await screen.findByRole('button', { name: 'Keep editing' }),
      );
      await settle();
      expect(document.activeElement).toBe(closeIn('New expense'));
    });

    it('Discard closes and returns focus to the trigger (not into the closing sheet)', async () => {
      mount();
      const trigger = screen.getByRole('button', { name: 'Open form' });
      trigger.focus();
      fireEvent.click(trigger);
      const gross = await screen.findByLabelText('Gross');
      gross.focus();
      fireEvent.change(gross, { target: { value: '12' } });
      fireEvent.keyDown(gross, { key: 'Escape' });
      fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
      // The discard's continuation closes the sheet a task later.
      await waitFor(() => expect(document.activeElement).toBe(trigger));
      expect(screen.queryByRole('dialog', { name: 'New expense' })).toBeNull();
      expect(ariaViolations).toEqual([]);
    });
  });
});

describe('ConfirmDialog focus (issue #268)', () => {
  it('Cancel returns focus to the button that asked', async () => {
    function Ask() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Delete draft…
          </button>
          <ConfirmDialog
            open={open}
            onOpenChange={setOpen}
            title="Delete?"
            body="Gone for good."
            confirmLabel="Delete"
            onConfirm={() => setOpen(false)}
          />
        </>
      );
    }
    render(<Ask />);
    const trigger = screen.getByRole('button', { name: 'Delete draft…' });
    trigger.focus();
    fireEvent.click(trigger);
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancel);
    fireEvent.click(cancel);
    await settle();
    expect(document.activeElement).toBe(trigger);
    expect(ariaViolations).toEqual([]);
  });
});
