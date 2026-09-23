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
 *  here in-app; falls back to `backTo` on deep-link entry — by REPLACE
 *  (issue #252): the parent takes the deep-linked entry's place, so its own
 *  Back never bounces into the screen just left. */
export function ScreenHeader({
  title,
  backTo,
  trailing,
  heading,
}: {
  title: string;
  backTo?: string;
  trailing?: ReactNode;
  /** A record's screen (issue #357): the title becomes the page's h1 and
   *  the focus target of a new entry (lib/screenEntry), named by what the
   *  record is — e.g. "Document scan.pdf" around a "1 of 79" title. */
  heading?: string;
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
          replace
          className="text-[15px] font-semibold text-accent"
        >
          ‹ Back
        </Link>
      )}
      {heading === undefined ? (
        <span className="text-[15px] font-bold">{title}</span>
      ) : (
        <h1
          data-screen-title=""
          tabIndex={-1}
          aria-label={
            heading.startsWith(title) ? heading : `${heading}, ${title}`
          }
          className="text-[15px] font-bold outline-none"
        >
          {title}
        </h1>
      )}
      <div className="min-w-[44px] text-right">{trailing}</div>
    </div>
  );
}
