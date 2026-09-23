import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { X } from 'lucide-react';
import { Drawer } from 'vaul';
import { useFocusReturn } from '../lib/focusReturn';
import { useModalLayer } from '../lib/modalLayers';
import type { DismissGuard } from '../lib/unsavedChanges';
import { SegmentedControl } from './SegmentedControl';

// vaul's own reset transition (TRANSITIONS in vaul/dist) — used to put a
// swiped-down drawer back when a close is vetoed.
const VAUL_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
// Rounding slack between innerHeight (integer) and visualViewport.height
// (fractional) when nothing covers the page.
const VIEWPORT_SLACK = 1;

/** Bottom sheet for actions attached to the current screen (spec: action =
 *  sheet; object with identity = route; irreversible = ConfirmDialog).
 *
 *  Every way out is one path (issue #267): the explicit Close button,
 *  Escape, backdrop, swipe and browser Back/Forward (lib/modalLayers — the
 *  top layer closes, the route stays) all go through `handleOpenChange`, so
 *  a save in flight refuses them all and a dirty form asks before any. */
export function Sheet({
  open,
  onOpenChange,
  title,
  guard,
  busy = false,
  source,
  returnFocusFallback,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  /** Unsaved-input guard of the form inside (lib/unsavedChanges): a dismiss
   *  (Close, Escape, backdrop, swipe, Back) while it is dirty asks before closing. */
  guard?: DismissGuard;
  /** A save is in flight (lib/pendingOperation, issue #251): every dismiss
   *  is refused (drawer put back), and no discard question is asked for a
   *  form that is mid-save. */
  busy?: boolean;
  /** The document this form verifies (issue #257). Given, the sheet grows
   *  to full height: side by side with the form on wide screens; a
   *  Form/Source switch on narrow ones. Both panes stay MOUNTED — the hidden
   *  one is only `invisible` — so typed input, the form's scroll and the
   *  viewer's page/zoom survive every switch. Switching is view state:
   *  never a dismissal, never consults or releases the guard, and stays
   *  available while busy. Absent, the sheet is unchanged. */
  source?: ReactNode;
  /** Where focus goes on close when the opener can no longer take it — a
   *  same-screen element that is meaningful after a success removed or
   *  disabled the trigger (issue #268). Read at restore time. */
  returnFocusFallback?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const [view, setView] = useState<'form' | 'source'>('form');
  const contentRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const vetoFrame = useRef<number | null>(null);
  // Focus (issue #268, lib/focusReturn): the opener is captured at the open
  // edge, before the belts below release it; focus starts on the explicit
  // Close button (never an editable field — no mobile keyboard pop), and
  // returns from Radix's close-autofocus, after the exit animation lifted
  // aria-hidden: to the opener, else `returnFocusFallback`, else nowhere —
  // and never while someone else holds focus, a newer layer is on top, or
  // the route moved on. The belts stay (useFocusReturn): the open edge
  // blurs OUTSIDE focus before Radix aria-hides the app root around it, the
  // close edge releases INSIDE focus before a layer opening in the same
  // moment (CreateMenu's onPick handoff) aria-hides this one.
  const closeRef = useRef<HTMLButtonElement>(null);
  const focus = useFocusReturn({
    open,
    contentRef,
    fallback: returnFocusFallback,
    initialFocus: () => {
      const close = closeRef.current;
      return close !== null && !close.disabled ? close : contentRef.current;
    },
  });
  // This open generation: bumped when `open` flips and on unmount, so a
  // discard answered late (question superseded, sheet closed another way
  // and reopened, or unmounted) can never close a newer generation.
  const generation = useRef(0);
  useLayoutEffect(
    () => () => {
      generation.current += 1;
    },
    [open],
  );
  const latestOnOpenChange = useRef(onOpenChange);
  latestOnOpenChange.current = onOpenChange;
  const handleOpenChange = (o: boolean) => {
    if (!o && busy) {
      restoreAfterVeto();
      return;
    }
    if (!o && guard?.isDirty()) {
      // Veto: `open` stays true, but vaul has already started its close —
      // a swipe leaves the panel translated down and vaul re-enables body
      // pointer-events right after this callback. Put both back (mirrors
      // vaul's resetDrawer); focus stays where it was, so Radix returns it
      // there when the discard dialog closes.
      restoreAfterVeto();
      const asked = generation.current;
      void guard.confirmDiscard().then((ok) => {
        if (!ok || generation.current !== asked) return;
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        latestOnOpenChange.current(false);
      });
      return;
    }
    if (!o && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    onOpenChange(o);
  };
  // Back/Forward while this is the top layer: the same dismiss request.
  useModalLayer(
    open,
    () => {
      if (busy) return false;
      handleOpenChange(false);
      return true;
    },
    contentRef,
  );
  const restoreAfterVeto = () => {
    const content = contentRef.current;
    // A refused dismiss keeps focus in the sheet (issue #268) — e.g. the
    // submit that held it was disabled by the save in flight.
    if (content && !content.contains(document.activeElement)) {
      content.focus({ preventScroll: true });
    }
    if (content) {
      content.style.transition = `transform 0.5s ${VAUL_EASE}`;
      content.style.transform = 'translate3d(0, 0, 0)';
    }
    const overlay = overlayRef.current;
    if (overlay) {
      overlay.style.transition = `opacity 0.5s ${VAUL_EASE}`;
      overlay.style.opacity = '1';
    }
    // vaul sets body pointer-events to 'auto' AFTER this callback returns;
    // put back the value Radix's modal layer owns right now — only while
    // this sheet is still mounted and open (a 401 or route unmount in
    // between must never leave the next screen locked).
    const lock = document.body.style.pointerEvents;
    if (vetoFrame.current !== null) cancelAnimationFrame(vetoFrame.current);
    vetoFrame.current = requestAnimationFrame(() => {
      vetoFrame.current = null;
      const el = contentRef.current;
      if (el?.isConnected && el.getAttribute('data-state') === 'open') {
        document.body.style.pointerEvents = lock;
      }
    });
  };
  useEffect(
    () => () => {
      if (vetoFrame.current !== null) cancelAnimationFrame(vetoFrame.current);
    },
    [],
  );
  // Viewport restore (issue #362): vaul's repositionInputs sizes the panel
  // for the keyboard with inline height/bottom, and when it judges the
  // keyboard closed it writes back an `initialDrawerHeight` it captured once
  // per mounted Root — a height already shrunk if that first event was a
  // layout resize (smaller window, rotation). Whenever the visual viewport
  // coincides with the layout viewport (same height within rounding, no
  // zoom, not panned), those inline values only pin a stale size: drop them
  // so the CSS height (max-h/h 92vh) rules again. While a keyboard, zoom or
  // pan sets the visual viewport apart, vaul's handling stays untouched.
  // vaul re-registers its listener on every window resize (its snap-point
  // offsets depend on window size), so it may run after this one: check
  // again in the next frame, before paint — for the panel the event was
  // for, only while it is still this sheet's open panel and the viewport
  // still coincides. No transform, focus or scroll is touched.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let frame: number | null = null;
    const release = (el: HTMLDivElement | null) => {
      if (!el || el !== contentRef.current || !el.isConnected) return;
      if (el.getAttribute('data-state') !== 'open') return;
      if (vv.scale !== 1 || vv.offsetTop !== 0 || vv.offsetLeft !== 0) return;
      if (Math.abs(window.innerHeight - vv.height) > VIEWPORT_SLACK) return;
      el.style.removeProperty('height');
      el.style.removeProperty('bottom');
    };
    const onResize = () => {
      const el = contentRef.current;
      release(el);
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        release(el);
      });
    };
    vv.addEventListener('resize', onResize);
    return () => {
      vv.removeEventListener('resize', onResize);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <Drawer.Root open={open} onOpenChange={handleOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay
          ref={overlayRef}
          className="fixed inset-0 z-40 bg-black/45"
        />
        <Drawer.Content
          ref={contentRef}
          onOpenAutoFocus={focus.onOpenAutoFocus}
          onCloseAutoFocus={focus.onCloseAutoFocus}
          // Desktop width (issue #283): inset-x-0 + mx-auto + max-width
          // centres the panel by layout alone — vaul owns `transform` (drag,
          // open/close, the veto reset above), so no translate is used. A
          // form reads at a bounded column from md up; a source sheet gets
          // a wide bound so document and form sit side by side (lg split).
          // Phones keep the full-width bottom sheet.
          className={`fixed inset-x-0 bottom-0 z-50 mx-auto flex flex-col rounded-t-3xl bg-bg outline-none ${
            source === undefined
              ? 'max-h-[92vh] pb-6 md:max-w-xl'
              : 'h-[92vh] pb-3 lg:max-w-7xl'
          }`}
        >
          <div className="mx-auto mb-3 mt-2.5 h-1 w-10 flex-none rounded-full bg-handle" />
          {/* Explicit exit (issue #267): gestures are never the only way
              out. Outside any form and type=button — it never submits. */}
          <button
            type="button"
            ref={closeRef}
            aria-label="Close"
            data-vaul-no-drag
            disabled={busy}
            onClick={() => handleOpenChange(false)}
            className="absolute right-2 top-2 flex h-11 w-11 items-center justify-center rounded-full text-ink-2 hover:bg-line/60 disabled:opacity-40"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
          {title != null && (
            <Drawer.Title className="mb-2 flex-none px-14 text-center text-lg font-extrabold">
              {title}
            </Drawer.Title>
          )}
          {source === undefined ? (
            <div className="overflow-y-auto">{children}</div>
          ) : (
            <>
              <div className="mb-2 flex-none px-5 lg:hidden">
                <SegmentedControl
                  label="Sheet view"
                  options={[
                    { value: 'form', label: 'Form' },
                    { value: 'source', label: 'Source document' },
                  ]}
                  value={view}
                  onChange={setView}
                />
              </div>
              <div className="relative min-h-0 flex-1 lg:grid lg:grid-cols-2 lg:grid-rows-[minmax(0,1fr)] lg:gap-4 lg:px-5">
                <div
                  data-vaul-no-drag
                  data-sheet-pane="source"
                  data-active={view === 'source'}
                  className={`absolute inset-0 overflow-hidden lg:static lg:visible lg:rounded-2xl lg:border lg:border-line ${
                    view === 'source' ? '' : 'invisible'
                  }`}
                >
                  {source}
                </div>
                <div
                  data-sheet-pane="form"
                  data-active={view === 'form'}
                  className={`absolute inset-0 overflow-y-auto lg:static lg:visible ${
                    view === 'form' ? '' : 'invisible'
                  }`}
                >
                  {children}
                </div>
              </div>
            </>
          )}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
