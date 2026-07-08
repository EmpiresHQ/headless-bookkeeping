import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';

export function LargeTitleHeader({
  title,
  trailing,
}: {
  title: string;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex items-end justify-between px-5 pb-2 pt-5">
      <h1 className="text-[29px] font-extrabold tracking-tight">{title}</h1>
      {trailing != null && <div className="pb-1">{trailing}</div>}
    </div>
  );
}

/** Stack header with an honest back button: history.back() when we navigated
 *  here in-app; falls back to `backTo` on deep-link entry. */
export function ScreenHeader({
  title,
  backTo,
  trailing,
}: {
  title: string;
  backTo?: string;
  trailing?: ReactNode;
}) {
  const navigate = useNavigate();
  const canGoBack = window.history.state?.idx > 0;
  return (
    <div className="flex items-center justify-between px-4 py-2.5">
      {canGoBack || backTo == null ? (
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="text-[15px] font-semibold text-accent"
        >
          ‹ Back
        </button>
      ) : (
        <Link
          to={backTo}
          viewTransition
          className="text-[15px] font-semibold text-accent"
        >
          ‹ Back
        </Link>
      )}
      <span className="text-[15px] font-bold">{title}</span>
      <div className="min-w-[44px] text-right">{trailing}</div>
    </div>
  );
}
