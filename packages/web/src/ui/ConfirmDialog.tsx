import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { useRef, type ReactNode } from 'react';
import { useModalLayer } from '../lib/modalLayers';
import { Button } from './Button';

/** Explicit confirm for irreversible actions (period lock, delete).
 *  Never optimistic; never window.confirm. While `busy` (the confirmed
 *  action is in flight, issue #251) it cannot be dismissed — Cancel,
 *  Escape and the overlay are refused — so the action's outcome is shown
 *  where it was confirmed. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  busy = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  // Back/Forward while this is the top layer (issue #267): same as Cancel.
  useModalLayer(
    open,
    () => {
      if (busy) return false;
      onOpenChange(false);
      return true;
    },
    contentRef,
  );
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o && busy) return;
        onOpenChange(o);
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/45" />
        <AlertDialog.Content
          ref={contentRef}
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-48px)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-surface p-5"
        >
          <AlertDialog.Title className="text-[17px] font-extrabold">
            {title}
          </AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="mt-2 text-[13.5px] text-ink-2">{body}</div>
          </AlertDialog.Description>
          <div className="mt-4 flex gap-2.5">
            <AlertDialog.Cancel asChild>
              <Button variant="secondary" className="flex-1" disabled={busy}>
                {cancelLabel}
              </Button>
            </AlertDialog.Cancel>
            <Button
              variant={destructive ? 'danger' : 'primary'}
              className="flex-1"
              busy={busy}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
