import { TriangleAlert } from 'lucide-react';
import {
  Component,
  lazy,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { useConfirmLeave } from '../lib/unsavedChanges';
import { reloadPage } from '../lib/reloadPage';
import { Button } from '../ui/Button';
import { ListGroup, ListRow } from '../ui/List';
import { ScreenHeader } from './Headers';
import { NAV_ITEMS } from './nav';

/** A routed screen's code could not be loaded (issue #292): its import()
 *  rejected — a dropped connection, a chunk an older page asks for that a
 *  newer deployment no longer serves, or a module that failed to evaluate.
 *  Which one is not known here. Never a data/API error. */
export class ScreenLoadError extends Error {
  /** The import's own rejection, for the console only. */
  readonly reason: unknown;
  constructor(reason: unknown) {
    super('Screen code could not be loaded');
    this.name = 'ScreenLoadError';
    this.reason = reason;
  }
}

/** React.lazy for a routed screen: every rejection of its import is a
 *  ScreenLoadError, so the shell can tell it from a screen that broke while
 *  rendering. React caches the rejection: re-rendering (or re-entering the
 *  route) shows the same failure at once, never a new attempt — only a page
 *  reload tries to load the code again. */
export function lazyScreen(
  load: () => Promise<{ default: ComponentType }>,
): ComponentType {
  return lazy(() =>
    load().catch((e: unknown) => {
      throw new ScreenLoadError(e);
    }),
  );
}

/** Catches what the routed screen throws — inside the shell, so the
 *  sidebar, tab bar, recent results and every guard stay mounted. Cleared
 *  by any navigation (`resetKey` is the location key): the next screen gets
 *  its own chance, and a cached failed screen fails again at once. */
export class ScreenBoundary extends Component<
  { resetKey: string; children: ReactNode },
  { error: unknown; resetKey: string; failed: boolean }
> {
  state = {
    error: null as unknown,
    resetKey: this.props.resetKey,
    failed: false,
  };

  static getDerivedStateFromError(error: unknown) {
    return { error, failed: true };
  }

  static getDerivedStateFromProps(
    props: { resetKey: string },
    state: { resetKey: string; failed: boolean },
  ) {
    if (props.resetKey === state.resetKey) return null;
    return { error: null, failed: false, resetKey: props.resetKey };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // For whoever debugs it — never on screen (chunk URLs, stacks).
    const reason = error instanceof ScreenLoadError ? error.reason : error;
    console.error('Screen failed', reason, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <ScreenFailure loadFailed={this.state.error instanceof ScreenLoadError} />
    );
  }
}

/** The failed-screen state, in place: the address (path, query, hash)
 *  stays as it was. Reload is the one honest retry — a rejected import is
 *  not tried again in this page — and it goes through the same leave guard
 *  as sign-out: refused while an operation is still saving, asks about
 *  unsaved changes. Eager (part of the shell), like NotFoundScreen. */
function ScreenFailure({ loadFailed }: { loadFailed: boolean }) {
  const confirmLeave = useConfirmLeave();
  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title="Screen unavailable" backTo="/inbox" />
      <div
        role="alert"
        className="flex flex-col items-center gap-2 px-6 py-8 text-center"
      >
        <TriangleAlert
          size={30}
          strokeWidth={2}
          aria-hidden="true"
          className="text-ink-2"
        />
        <h1 className="text-[17px] font-bold">
          {loadFailed
            ? 'This screen could not be loaded'
            : 'This screen stopped working'}
        </h1>
        <p className="text-[13px] text-ink-2">
          {loadFailed
            ? 'The app could not load this screen. This can happen when the connection drops or after the app has been updated. Reload the page to try opening it again.'
            : 'Something went wrong while showing this screen. Reload the page to try opening it again.'}
        </p>
        <Button className="mt-2" onClick={() => confirmLeave(reloadPage)}>
          Reload page
        </Button>
      </div>
      <ListGroup label="Or go to a section">
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
