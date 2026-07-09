import { Button } from '../ui/Button';

/** Explicit query-error state for bank screens: server text + retry. */
export function LoadError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="mx-3.5 mb-3.5 rounded-2xl bg-err-bg px-4 py-3.5">
      <p className="text-[13px] font-semibold text-err">{message}</p>
      <Button variant="secondary" className="mt-2" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
