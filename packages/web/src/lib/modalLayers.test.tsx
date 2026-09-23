import { render } from '@testing-library/react';
import { useRef, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  createModalLayerRegistry,
  ModalLayerContext,
  useModalLayer,
  type ModalLayerRegistry,
} from './modalLayers';

function Layer({
  open,
  onDismiss,
  children,
}: {
  open: boolean;
  onDismiss: () => void;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModalLayer(
    open,
    () => {
      onDismiss();
      return true;
    },
    ref,
  );
  return <div ref={ref}>{children}</div>;
}

const withRegistry = (registry: ModalLayerRegistry, ui: ReactNode) => (
  <ModalLayerContext.Provider value={registry}>{ui}</ModalLayerContext.Provider>
);

describe('modal layers (#267)', () => {
  it('registers only while open and unregisters on close and unmount', () => {
    const registry = createModalLayerRegistry();
    const dismiss = vi.fn();
    const { rerender, unmount } = render(
      withRegistry(registry, <Layer open={false} onDismiss={dismiss} />),
    );
    expect(registry.count()).toBe(0);
    rerender(withRegistry(registry, <Layer open onDismiss={dismiss} />));
    expect(registry.count()).toBe(1);
    const first = registry.top();
    rerender(
      withRegistry(registry, <Layer open={false} onDismiss={dismiss} />),
    );
    expect(registry.count()).toBe(0);
    expect(first !== null && registry.has(first)).toBe(false);
    // Reopening is a NEW registration (a new generation).
    rerender(withRegistry(registry, <Layer open onDismiss={dismiss} />));
    expect(registry.top()).not.toBe(first);
    unmount();
    expect(registry.count()).toBe(0);
  });

  it('top is the nested / later layer even when both mount open at once', () => {
    const registry = createModalLayerRegistry();
    const outer = vi.fn();
    const inner = vi.fn();
    render(
      withRegistry(
        registry,
        <Layer open onDismiss={outer}>
          <Layer open onDismiss={inner} />
        </Layer>,
      ),
    );
    // The inner layer registers FIRST (child layout effects run first);
    // document order still puts it on top.
    registry.top()?.dismiss();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it('dismiss reads the latest props', () => {
    const registry = createModalLayerRegistry();
    const a = vi.fn();
    const b = vi.fn();
    const { rerender } = render(
      withRegistry(registry, <Layer open onDismiss={a} />),
    );
    rerender(withRegistry(registry, <Layer open onDismiss={b} />));
    registry.top()?.dismiss();
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
  });

  it('retireOpen: only layers open NOW stop counting; later ones count; undo restores', () => {
    const registry = createModalLayerRegistry();
    const old = vi.fn();
    const later = vi.fn();
    const { rerender } = render(
      withRegistry(
        registry,
        <>
          <Layer open onDismiss={old} />
          <Layer open={false} onDismiss={later} />
        </>,
      ),
    );
    const undo = registry.retireOpen();
    expect(registry.count()).toBe(0);
    expect(registry.top()).toBeNull();
    rerender(
      withRegistry(
        registry,
        <>
          <Layer open onDismiss={old} />
          <Layer open onDismiss={later} />
        </>,
      ),
    );
    expect(registry.count()).toBe(1);
    registry.top()?.dismiss();
    expect(later).toHaveBeenCalledTimes(1);
    expect(old).not.toHaveBeenCalled();
    undo();
    expect(registry.count()).toBe(2);
  });

  it('overlapping retirements own disjoint layers; each undo restores only its own', () => {
    const registry = createModalLayerRegistry();
    const view = (a: boolean, b: boolean) =>
      withRegistry(
        registry,
        <>
          <Layer open={a} onDismiss={vi.fn()} />
          <Layer open={b} onDismiss={vi.fn()} />
        </>,
      );
    const { rerender } = render(view(true, false));
    const undoFirst = registry.retireOpen();
    rerender(view(true, true));
    const undoSecond = registry.retireOpen();
    expect(registry.count()).toBe(0);
    undoFirst();
    expect(registry.count()).toBe(1);
    undoSecond();
    expect(registry.count()).toBe(2);
  });

  it('an undo never touches a later registration of the same component', () => {
    const registry = createModalLayerRegistry();
    const view = (open: boolean) =>
      withRegistry(registry, <Layer open={open} onDismiss={vi.fn()} />);
    const { rerender } = render(view(true));
    const undo = registry.retireOpen();
    rerender(view(false));
    rerender(view(true));
    expect(registry.count()).toBe(1);
    const reopened = registry.top();
    undo();
    expect(registry.count()).toBe(1);
    expect(registry.top()).toBe(reopened);
  });

  it('without a registry (isolated tests) it is a no-op', () => {
    expect(() => render(<Layer open onDismiss={vi.fn()} />)).not.toThrow();
  });
});
