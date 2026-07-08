import { Toaster, toast } from 'sonner';

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
