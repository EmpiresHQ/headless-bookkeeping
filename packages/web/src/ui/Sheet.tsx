import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Drawer } from 'vaul';
import type { DismissGuard } from '../lib/unsavedChanges';
import { SegmentedControl } from './SegmentedControl';

// vaul's own reset transition (TRANSITIONS in vaul/dist) — used to put a
// swiped-down drawer back when a close is vetoed.
const VAUL_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';

/** Bottom sheet for actions attached to the current screen (spec: action =
 *  sheet; object with identity = route; irreversible = ConfirmDialog). */
export function Sheet({
  open,
  onOpenChange,
  title,
  guard,
  busy = false,
  source,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  /** Unsaved-input guard of the form inside (lib/unsavedChanges): a dismiss
   *  (Escape, backdrop, swipe) while it is dirty asks before closing. */
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
  children: ReactNode;
}) {
  const [view, setView] = useState<'form' | 'source'>('form');
  const contentRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const vetoFrame = useRef<number | null>(null);
  // Radix marks the app root aria-hidden while the sheet animates out; if
  // focus is still INSIDE the closing sheet the browser logs "Blocked
  // aria-hidden on an element because its descendant retained focus".
  // Release focus on both paths that can flip a close: closes ROUTED
  // through Radix/vaul's own onOpenChange (Escape, backdrop, swipe) via
  // handleOpenChange, and closes where a caller flips the `open` PROP
  // directly from a click inside the sheet's own content without ever
  // calling onOpenChange (e.g. CreateMenu's row onPick) via the layout
  // effect below.
  //
  // RESIDUAL GAP CLOSED (Plan 07 Task 7, closed out at the ExpenseScreen/
  // InvoiceScreen CorrectSheet sites): every sheet call site now keeps its
  // sheet MOUNTED once first opened (open flag + remount-on-open epoch key,
  // lib/useSheet) so Radix runs its graceful close lifecycle and focus
  // restoration lands AFTER aria-hidden lifts — including sites whose
  // TRIGGER is gated on business state (e.g. a 'posted' status) that can
  // itself flip mid-close from the same action that closes the sheet; only
  // the trigger stays gated, the mount does not. The blur belts below
  // remain as defense-in-depth for direct open-prop flips.
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
      void guard.confirmDiscard().then((ok) => {
        if (!ok) return;
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        onOpenChange(false);
      });
      return;
    }
    if (!o && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    onOpenChange(o);
  };
  const restoreAfterVeto = () => {
    const content = contentRef.current;
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
  // OPEN edge (Plan 07 Task 9 smoke): the trigger button keeps focus after
  // the click that opens the sheet, and vaul deliberately prevents Radix's
  // open-autofocus (autoFocus=false — no mobile keyboard pop). Radix then
  // marks the app root aria-hidden with the still-focused trigger inside it
  // and the browser logs the same "Blocked aria-hidden" warning at OPEN that
  // Task 7 closed at CLOSE. Blur the outside-focused element on the open
  // edge too. Skipped when mounting closed (always-mounted sheets must not
  // steal focus from the screen at initial render).
  const everOpen = useRef(open);
  if (open) everOpen.current = true;
  useLayoutEffect(() => {
    if (everOpen.current && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }, [open]);
  return (
    <Drawer.Root open={open} onOpenChange={handleOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay
          ref={overlayRef}
          className="fixed inset-0 z-40 bg-black/45"
        />
        <Drawer.Content
          ref={contentRef}
          onCloseAutoFocus={(e) => e.preventDefault()}
          className={`fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-3xl bg-bg outline-none ${
            source === undefined ? 'max-h-[92vh] pb-6' : 'h-[92vh] pb-3'
          }`}
        >
          <div className="mx-auto mb-3 mt-2.5 h-1 w-10 flex-none rounded-full bg-handle" />
          {title != null && (
            <Drawer.Title className="mb-2 flex-none px-6 text-center text-lg font-extrabold">
              {title}
            </Drawer.Title>
          )}
          {source === undefined ? (
            <div className="overflow-y-auto">{children}</div>
          ) : (
            <>
              <div className="mb-2 flex-none px-5 lg:hidden">
                <SegmentedControl
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
