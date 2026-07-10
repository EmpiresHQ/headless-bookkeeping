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
  // RESIDUAL GAP CLOSED (Plan 07 Task 7): every sheet call site now keeps
  // its sheet MOUNTED (open flag + remount-on-open epoch key, lib/useSheet)
  // so Radix runs its graceful close lifecycle and focus restoration lands
  // AFTER aria-hidden lifts. The blur belts below remain as
  // defense-in-depth for direct open-prop flips.
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
