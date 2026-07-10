import type { ReactNode } from 'react';
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
  const handleOpenChange = (o: boolean) => {
    // Radix marks the app root aria-hidden while the sheet animates out; if
    // focus is still INSIDE the closing sheet the browser logs "Blocked
    // aria-hidden on an element because its descendant retained focus".
    // Release focus before the state flips (P05-routed a11y fix).
    if (!o && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    onOpenChange(o);
  };
  return (
    <Drawer.Root open={open} onOpenChange={handleOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/45" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 flex max-h-[92vh] flex-col rounded-t-3xl bg-bg pb-6 outline-none">
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
