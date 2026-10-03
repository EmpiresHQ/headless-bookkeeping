import { KEEPS_POSITION } from '../lib/listPosition';
import { Button } from './Button';

/** Explicit query-error state: server text + retry. */
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
      {/* Retry is a recovery (issue #283): it brings back what failed and
          must not count as scroll intent against a pending list return. */}
      <Button
        variant="secondary"
        className="mt-2"
        onClick={onRetry}
        {...{ [KEEPS_POSITION]: '' }}
      >
        Retry
      </Button>
    </div>
  );
}

/** A failed BACKGROUND refetch while cached data is still shown: say so and
 *  offer a retry, without replacing the screen — which would unmount any
 *  form on it and drop the operator's unsaved input (issue #250). Screens
 *  return the full LoadError only while there is no data at all. */
export function RefetchError({
  query,
}: {
  query: { isError: boolean; error: unknown; refetch: () => unknown };
}) {
  if (!query.isError) return null;
  return (
    <LoadError
      message={
        query.error instanceof Error
          ? `Could not refresh — ${query.error.message}`
          : 'Could not refresh'
      }
      onRetry={() => void query.refetch()}
    />
  );
}
