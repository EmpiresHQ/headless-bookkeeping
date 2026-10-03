import { createContext, forwardRef, useContext } from 'react';
import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

/** Shared with LinkButton (a Link styled as this same kit Button) — keep
 *  primary/secondary here as the single source of truth so the two never
 *  drift apart visually. */
export const BUTTON_VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-white',
  secondary: 'bg-fill text-ink',
  danger: 'bg-err text-white',
  ghost: 'bg-transparent text-accent',
};

const VARIANTS = BUTTON_VARIANTS;

/** True inside a container that already announces its own pending status
 *  (PendingFieldset) — a busy Button there adds no second live region. */
export const PendingAnnouncedContext = createContext(false);

export const DEFAULT_PENDING_LABEL = 'Working… please wait.';

/**
 * While `busy` (issue #281) the button keeps its children — the operation's
 * name and the box it measures stay exactly as they were — and is natively
 * disabled + aria-busy. The pending cue is drawn by CSS on
 * `[data-pending]` (index.css: a bar in the background, no extra box). The
 * announcement is a polite status that is the button's SIBLING, not a
 * descendant: a button's content is its name (no flattening "Working" into
 * it) and nothing inside the aria-busy subtree needs to be announced. That
 * status is always mounted for a button that takes `busy` at all, so it
 * exists before it has text; plain buttons get none.
 */
export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: Variant;
    busy?: boolean;
    /** What the status announces while busy. */
    pendingLabel?: string;
  }
>(function Button(
  {
    variant = 'primary',
    busy,
    pendingLabel = DEFAULT_PENDING_LABEL,
    className = '',
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  const announcedByContainer = useContext(PendingAnnouncedContext);
  const button = (
    <button
      ref={ref}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      data-pending={busy || undefined}
      className={`rounded-xl px-4 py-2.5 text-[15px] font-bold transition-opacity disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
  if (busy === undefined || announcedByContainer) return button;
  return (
    <>
      {button}
      <span role="status" className="sr-only">
        {busy ? pendingLabel : ''}
      </span>
    </>
  );
});
