import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { useRef, type ReactNode } from 'react';
import { useFocusReturn } from '../lib/focusReturn';
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
  // Focus (issue #268): Radix still starts on Cancel; on close focus returns
  // to where it was when the question opened — inside a still-open sheet
  // for "Keep editing" — never into a closing sheet (its own return
  // applies), under a newer layer or after the route moved on.
  const focus = useFocusReturn({ open, contentRef });
  // Long or enlarged text (issue #366): the dialog is bounded by the
  // viewport and scrolls as ONE region — title, warning and both actions —
  // so nothing is ever out of reach and no action is pinned over the text.
  // It opens at the top (Radix focuses Cancel with preventScroll), so the
  // question is read first. Focus that the trap MOVES with Tab/Shift+Tab
  // also uses preventScroll when it wraps around; bring that into view —
  // only focus moved by the Tab key being pressed now.
  const tabbed = useRef(false);
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
          onOpenAutoFocus={(e) => {
            // Never a Tab left over from before (one that moved nothing).
            tabbed.current = false;
            focus.onOpenAutoFocus(e);
          }}
          onCloseAutoFocus={focus.onCloseAutoFocus}
          onKeyDown={(e) => {
            if (e.key === 'Tab') tabbed.current = true;
          }}
          onKeyUp={() => {
            tabbed.current = false;
          }}
          onFocus={(e) => {
            if (!tabbed.current) return;
            tabbed.current = false;
            if (e.target !== e.currentTarget)
              e.target.scrollIntoView?.({ block: 'nearest' });
          }}
          className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-32px)] w-[calc(100vw-48px)] max-w-sm -translate-x-1/2 -translate-y-1/2 overflow-y-auto overscroll-contain rounded-2xl bg-surface p-5 [overflow-wrap:anywhere] supports-[height:100dvh]:max-h-[calc(100dvh-32px)]"
        >
          <AlertDialog.Title className="text-[17px] font-extrabold">
            {title}
          </AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="mt-2 text-[13.5px] text-ink-2">{body}</div>
          </AlertDialog.Description>
          {/* Two equal columns, as before; when both labels no longer fit
              side by side (enlarged text) they stack full-width instead of
              spilling out — the 6em threshold scales with the label size. */}
          <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(min(100%,6em),1fr))] gap-2.5 text-[15px]">
            <AlertDialog.Cancel asChild>
              <Button variant="secondary" className="min-w-0" disabled={busy}>
                {cancelLabel}
              </Button>
            </AlertDialog.Cancel>
            <Button
              variant={destructive ? 'danger' : 'primary'}
              className="min-w-0"
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
