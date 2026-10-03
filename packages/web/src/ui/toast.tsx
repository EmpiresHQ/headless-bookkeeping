import { Toaster, toast } from 'sonner';
// Sonner injects these rules at runtime too, but a host CSP can reject that
// <style> tag. Bundle them so the toaster remains a fixed overlay.
import 'sonner/dist/styles.css';

export function AppToaster() {
  return <Toaster position="top-center" richColors closeButton={false} />;
}

export const toastOk = (message: string) => toast.success(message);
export const toastErr = (message: string) => toast.error(message);

/** Optimistic-action receipt with 5s undo (spec: reversible actions get
 *  Undo, not "Are you sure?"). */
export function toastUndo(message: string, onUndo: () => void) {
  toast(message, {
    duration: 5000,
    action: { label: 'Undo', onClick: onUndo },
  });
}

/** A status that replaces itself (fixed id) — e.g. the protected-wait
 *  notice when a leave is refused while an operation is in flight. */
export const toastWait = (id: string, message: string) =>
  toast.info(message, { id });

/** Drop every visible toast — an ended session's receipts are not shown
 *  under the next sign-in (issue #285). */
export const dismissToasts = () => toast.dismiss();
