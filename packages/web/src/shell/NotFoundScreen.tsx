import { Compass } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { ListGroup, ListRow, READABLE } from '../ui/List';
import { ScreenHeader } from './Headers';
import { NAV_ITEMS } from './nav';

/** Longest part of the requested path echoed back; the rest is elided. */
const MAX_SHOWN_PATH = 160;

/** The requested path as a person would read it. Only the pathname — the
 *  query and hash stay in the address bar and are never echoed (they may
 *  carry codes or tokens). A malformed escape is shown as typed. */
function shownPath(pathname: string): string {
  let path = pathname;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    // Not valid percent-encoding: the raw path is still readable.
  }
  return path.length > MAX_SHOWN_PATH
    ? `${path.slice(0, MAX_SHOWN_PATH)}…`
    : path;
}

/** Issue #291: an address no route matches. Rendered in place — the URL
 *  (query and hash included) stays in the address bar until the person
 *  chooses where to go: Back (in-app history, or Inbox by REPLACE on a
 *  deep link — ScreenHeader) or one of the sections.
 *  Eager (part of the shell): a missing screen chunk is not this state. */
export function NotFoundScreen() {
  const { pathname } = useLocation();
  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title="Not found" backTo="/inbox" />
      <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
        <Compass
          size={30}
          strokeWidth={2}
          aria-hidden="true"
          className="text-ink-2"
        />
        <h1 className="text-[17px] font-bold">
          This address does not open a screen
        </h1>
        <p
          className={`max-w-full font-mono text-[12.5px] text-ink-2 ${READABLE}`}
        >
          {shownPath(pathname)}
        </p>
        <p className="text-[13px] text-ink-2">
          The requested screen could not be opened. The link may have a typo or
          point to a screen that has moved.
        </p>
      </div>
      <ListGroup label="Go to a section">
        {NAV_ITEMS.map(({ to, label, Icon }) => (
          <ListRow
            key={to}
            to={to}
            leading={<Icon size={20} strokeWidth={2} aria-hidden="true" />}
            title={label}
          />
        ))}
      </ListGroup>
    </div>
  );
}
