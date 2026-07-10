import { useLayoutEffect, type ReactNode } from 'react';
import { Drawer } from 'vaul';

/** Bottom sheet for actions attached to the current screen (spec: action =
 *  sheet; object with identity = route; irreversible = ConfirmDialog). */
export function Sheet({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  children: ReactNode;
}) {
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
  // KNOWN RESIDUAL GAP (Task 14 smoke finding, NOT fully closed by either
  // blur path or by onCloseAutoFocus preventDefault below): whenever the
  // element that opened a sheet (its "trigger") remains mounted after the
  // sheet closes, Radix's own FocusScope still restores focus to that
  // trigger through an internal mechanism outside onOpenChange/
  // onCloseAutoFocus, landing while the trigger's ancestor is still
  // aria-hidden — reproduced on Escape-close for CreateEntitySheet's
  // "+ Add", Books' CreateMenu "+", and by extension any sheet whose
  // trigger persists. The browser logs the warning synchronously at the
  // moment of that transient conflict, so no application-level blur
  // timing (sync, layout-effect, or rAF-deferred — all tried) suppresses
  // it after the fact. A real fix needs either migrating these sheets off
  // the "parent unmounts to close" pattern so Radix can run its own
  // graceful close lifecycle, or neutralizing the trigger's focusability
  // while its sheet is open. Documented, not fixed here (structural).
  const handleOpenChange = (o: boolean) => {
    if (!o && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    onOpenChange(o);
  };
  useLayoutEffect(() => {
    if (!open && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }, [open]);
  return (
    <Drawer.Root open={open} onOpenChange={handleOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/45" />
        <Drawer.Content
          onCloseAutoFocus={(e) => e.preventDefault()}
          className="fixed inset-x-0 bottom-0 z-50 flex max-h-[92vh] flex-col rounded-t-3xl bg-bg pb-6 outline-none"
        >
          <div className="mx-auto mb-3 mt-2.5 h-1 w-10 flex-none rounded-full bg-handle" />
          {title != null && (
            <Drawer.Title className="mb-2 flex-none px-6 text-center text-lg font-extrabold">
              {title}
            </Drawer.Title>
          )}
          <div className="overflow-y-auto">{children}</div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
