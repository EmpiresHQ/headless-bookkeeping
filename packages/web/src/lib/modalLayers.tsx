import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  type RefObject,
} from 'react';

/**
 * Open modal layers (issue #267): Sheet, ConfirmDialog, the document preview
 * lightbox. The app's single route blocker (lib/unsavedChanges) spends a
 * history traversal (Back/Forward) on dismissing the TOP layer — the same
 * request Escape or the Close button makes — instead of leaving the route.
 * Layers never write history: no entries to consume after a close, nothing
 * a completion chain (lib/returnNavigation) has to prove around.
 */

export interface ModalLayer {
  /** Ask the layer to close (its guards apply); false when it refused
   *  (a save in flight). */
  dismiss: () => boolean;
  element: () => Element | null;
  seq: number;
}

export interface ModalLayerRegistry {
  register: (layer: Omit<ModalLayer, 'seq'>) => () => void;
  /** The layer opened last: later in the document (portals append in
   *  opening order; a nested layer lives inside its parent), else later
   *  registered. */
  top: () => ModalLayer | null;
  count: () => number;
  /** Retire every ACTIVE layer open now (a finished task's, closing in a
   *  commit that may land after the router already moved on): excluded
   *  from top()/count() until they unregister or the returned undo runs.
   *  The undo restores exactly those registrations (a layer opened later,
   *  or one another retirement took first, is never touched). */
  retireOpen: () => () => void;
  /** Still registered: the same open generation (a layer re-registers on
   *  every open, so identity is per generation). */
  has: (layer: ModalLayer) => boolean;
}

export function createModalLayerRegistry(): ModalLayerRegistry {
  const layers = new Set<ModalLayer>();
  const retired = new Set<ModalLayer>();
  const active = () => [...layers].filter((l) => !retired.has(l));
  let seq = 0;
  const above = (a: ModalLayer, b: ModalLayer): boolean => {
    const ea = a.element();
    const eb = b.element();
    if (ea?.isConnected && eb?.isConnected && ea !== eb) {
      return (
        (eb.compareDocumentPosition(ea) & Node.DOCUMENT_POSITION_FOLLOWING) !==
        0
      );
    }
    return a.seq > b.seq;
  };
  return {
    register: (layer) => {
      const entry = { ...layer, seq: ++seq };
      layers.add(entry);
      return () => {
        layers.delete(entry);
        retired.delete(entry);
      };
    },
    top: () => {
      let best: ModalLayer | null = null;
      for (const l of active()) if (best === null || above(l, best)) best = l;
      return best;
    },
    count: () => active().length,
    retireOpen: () => {
      const mine = active();
      mine.forEach((l) => retired.add(l));
      return () => mine.forEach((l) => retired.delete(l));
    },
    has: (layer) => layers.has(layer),
  };
}

export const ModalLayerContext = createContext<ModalLayerRegistry | null>(null);

/** Register while `open`. `dismiss` is read live (latest props). Outside the
 *  provider (isolated component tests) this is a no-op. */
export function useModalLayer(
  open: boolean,
  dismiss: () => boolean,
  ref: RefObject<Element | null>,
): void {
  const registry = useContext(ModalLayerContext);
  const latest = useRef(dismiss);
  latest.current = dismiss;
  useLayoutEffect(() => {
    if (!open || registry === null) return;
    return registry.register({
      dismiss: () => latest.current(),
      element: () => ref.current,
    });
  }, [open, registry, ref]);
}
