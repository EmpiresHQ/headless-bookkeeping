import { act, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { describe, expect, it } from 'vitest';
import {
  UnsavedChangesProvider,
  useConfirmLeave,
  useUnsavedChanges,
  type UnsavedGuard,
} from './unsavedChanges';

/** Dispatch a real beforeunload and report whether the page would ask. */
function unloadAsks(): boolean {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
}

let guard: UnsavedGuard<string>;
let setServer: (v: string) => void;

/** A minimal inline form: `server` is the canonical snapshot; the field is
 *  adopted from it on "save" the way OrgForm/SettingField do. */
function Form({ initial = 'A' }: { initial?: string }) {
  const [server, setS] = useState(initial);
  const [value, setValue] = useState(initial);
  setServer = setS;
  guard = useUnsavedChanges({ label: 'Form', values: value, baseline: server });
  return (
    <input
      aria-label="Field"
      value={value}
      onChange={(e) => setValue(e.target.value)}
    />
  );
}

function renderForm(ui = <Form />) {
  return render(
    <StrictMode>
      <UnsavedChangesProvider>{ui}</UnsavedChangesProvider>
    </StrictMode>,
  );
}

const type = (v: string) =>
  fireEvent.change(screen.getByLabelText('Field'), { target: { value: v } });

describe('useUnsavedChanges', () => {
  it('is dirty only while the values differ — a reverted edit is clean', () => {
    renderForm();
    expect(guard.isDirty()).toBe(false);
    expect(unloadAsks()).toBe(false);
    type('B');
    expect(guard.isDirty()).toBe(true);
    expect(unloadAsks()).toBe(true);
    type('A');
    expect(guard.isDirty()).toBe(false);
    expect(unloadAsks()).toBe(false);
  });

  it('a baseline that moves WITH the values (async prefill) is never dirty', () => {
    function Prefilled() {
      const [pair, setPair] = useState({ value: '', base: '' });
      guard = useUnsavedChanges({
        label: 'Prefilled',
        values: pair.value,
        baseline: pair.base,
      });
      setServer = (v) => setPair({ value: v, base: v });
      return null;
    }
    renderForm(<Prefilled />);
    act(() => setServer('48.20'));
    expect(guard.isDirty()).toBe(false);
    expect(unloadAsks()).toBe(false);
  });

  it('release() is synchronous — beforeunload stops asking in the same tick', () => {
    renderForm();
    type('B');
    expect(unloadAsks()).toBe(true);
    guard.release();
    expect(guard.isDirty()).toBe(false);
    expect(unloadAsks()).toBe(false);
    // A later edit is unsaved again.
    type('C');
    expect(guard.isDirty()).toBe(true);
  });

  it('a release retires once the baseline moves: save B, server normalizes to C, typing B again is dirty', () => {
    renderForm();
    type('B');
    guard.release(); // saved "B"…
    act(() => setServer('C')); // …the server stored it as "C"
    // The field still shows B while the canonical value is C: unsaved.
    expect(guard.isDirty()).toBe(true);
    type('C');
    expect(guard.isDirty()).toBe(false);
    type('B');
    expect(guard.isDirty()).toBe(true);
  });

  it('an inactive (closed) form never blocks', () => {
    function Closed() {
      guard = useUnsavedChanges({
        label: 'Closed',
        values: 'typed',
        baseline: '',
        active: false,
      });
      return null;
    }
    renderForm(<Closed />);
    expect(guard.isDirty()).toBe(false);
    expect(unloadAsks()).toBe(false);
  });

  it('unregisters on unmount — no stale unload prompt', () => {
    const { unmount } = renderForm();
    type('B');
    expect(unloadAsks()).toBe(true);
    unmount();
    expect(unloadAsks()).toBe(false);
  });

  it('throws outside the provider (no silent unguarded form)', () => {
    function Bare() {
      useUnsavedChanges({ label: 'x', values: 1, baseline: 1 });
      return null;
    }
    const err = console.error;
    console.error = () => undefined;
    try {
      expect(() => render(<Bare />)).toThrow(/UnsavedChangesProvider/);
    } finally {
      console.error = err;
    }
  });
});

describe('UnsavedChangesProvider confirmations', () => {
  it('confirmDiscard asks with the form label; Keep keeps, Discard releases', async () => {
    renderForm();
    type('B');
    let answer: Promise<boolean> = Promise.resolve(false);
    act(() => {
      answer = guard.confirmDiscard();
    });
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Form');
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(await answer).toBe(false);
    expect(guard.isDirty()).toBe(true);
    expect(screen.getByLabelText('Field')).toHaveValue('B');

    act(() => {
      answer = guard.confirmDiscard();
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    expect(await answer).toBe(true);
    expect(guard.isDirty()).toBe(false);
  });

  it('confirmLeave runs at once when clean and only after Discard when dirty', async () => {
    let leave: (fn: () => void) => void = () => undefined;
    function Leaver() {
      leave = useConfirmLeave();
      return null;
    }
    renderForm(
      <>
        <Form />
        <Leaver />
      </>,
    );
    let left = 0;
    act(() => leave(() => left++));
    expect(left).toBe(1);

    type('B');
    act(() => leave(() => left++));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Keep editing' }),
    );
    expect(left).toBe(1);
    act(() => leave(() => left++));
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    await act(async () => undefined);
    expect(left).toBe(2);
  });

  it('an unanswered question resolves "keep" when the provider unmounts (sign-out, 401)', async () => {
    const { unmount } = renderForm();
    type('B');
    let answer: Promise<boolean> = Promise.resolve(true);
    act(() => {
      answer = guard.confirmDiscard();
    });
    await screen.findByRole('alertdialog');
    unmount();
    expect(await answer).toBe(false);
  });
});
