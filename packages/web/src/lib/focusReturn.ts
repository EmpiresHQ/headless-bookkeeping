import { useContext, useLayoutEffect, useRef, type RefObject } from 'react';
import { ModalLayerContext } from './modalLayers';

/**
 * Focus return for modal layers (issue #268): Sheet, ConfirmDialog and the
 * document preview lightbox (issue #269).
 *
 * The opener is captured at the OPEN edge, before any belt blurs it, and
 * focus is given back only from Radix's close-autofocus — the lifecycle
 * point after the exit animation, when `hideOthers` has lifted aria-hidden
 * from the background — never on a timer. A restore acts only while focus
 * is free (nobody else took it), no newer layer is on top of the target,
 * the layer is really closed, and the pathname is still the one it opened
 * on. A route-changing completion therefore never refocuses the outgoing
 * screen (its opener, heading or fallback), even while a lazy destination
 * is still loading behind the new URL.
 *
 * The target is the opener, else the call site's explicit fallback (an
 * element meaningful on the same screen after a success removed the
 * trigger), else nothing moves — never a blind heading query.
 */

interface Custody {
  opener: HTMLElement | null;
  content: () => Element | null;
  /** The layer's `open` prop as last rendered — false already in the
   *  commit that closes it, before its own close edge has run. */
  isOpen: () => boolean;
  /** The Radix focus-scope container this generation mounted: the close
   *  event it dispatches later belongs to exactly this generation. */
  element: Element | null;
  /** open → closing (close edge) → done (restored or handed on). */
  state: 'open' | 'closing' | 'done';
  /** Focus was inside the layer when it closed, and that close is still
   *  the current task: a layer opening in this same task with nothing
   *  focused is its handoff successor. Cleared at the task boundary — a
   *  later, unrelated open never inherits this return. */
  releasedFocus: boolean;
  /** The pathname the layer opened on: a handoff never crosses routes. */
  pathname: string;
  /** The content mounted, so Radix will call close-autofocus. */
  contentSeen: boolean;
}

const custodies = new Set<Custody>();

const INTERACTIVE =
  'button, a[href], input, select, textarea, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [tabindex]';

// The click being handled, kept for the rest of that task only: a tap
// (touch/pointer) may not focus its button (platform-dependent), leaving
// document.activeElement on the body or on some EARLIER field — so the
// activated element outranks it. Records, never focuses; the task boundary
// marks "same activation", not a delay.
let activation: { el: Element | null } | null = null;
let listening = false;
function trackActivation(): void {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  document.addEventListener(
    'click',
    (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      const current = { el: t.closest(INTERACTIVE) };
      activation = current;
      setTimeout(() => {
        if (activation !== current) return;
        activation = null;
      }, 0);
    },
    { capture: true },
  );
}

function holderOf(el: Element): Custody | undefined {
  for (const c of custodies) {
    if (
      (c.state === 'closing' || (c.state === 'open' && !c.isOpen())) &&
      c.pathname === window.location.pathname &&
      c.content()?.contains(el)
    )
      return c;
  }
  return undefined;
}

/** The element to return to when a layer opening NOW closes. */
function captureOpener(): HTMLElement | null {
  const active = document.activeElement;
  // A click in this task names the invoker (a non-interactive target names
  // none — an older focused element is then not the opener either);
  // otherwise (keyboard, programmatic) the focused element does.
  const candidate =
    activation !== null
      ? activation.el instanceof HTMLElement && activation.el.isConnected
        ? activation.el
        : null
      : active instanceof HTMLElement && active !== document.body
        ? active
        : null;
  if (candidate !== null) {
    // Picked from inside a closing layer (menu row → form): that row is
    // about to go; return where the closing layer would have.
    const holder = holderOf(candidate);
    if (holder === undefined) return candidate;
    holder.state = 'done';
    return holder.opener;
  }
  // Nothing focused: a closing layer's own close edge released focus in
  // this same task (its layout effect ran first) — the same handoff. Only
  // on the same route; a later or unrelated open finds none.
  let successor: Custody | undefined;
  for (const c of custodies) {
    if (
      c.state === 'closing' &&
      c.releasedFocus &&
      c.pathname === window.location.pathname
    )
      successor = c;
  }
  if (successor === undefined) return null;
  successor.state = 'done';
  return successor.opener;
}

/** Can take focus meaningfully right now. */
export function isUsableFocusTarget(el: HTMLElement | null): el is HTMLElement {
  if (el === null || !el.isConnected) return false;
  if (el.matches(':disabled')) return false;
  if (el.closest('[inert], [aria-hidden="true"], [hidden]') !== null)
    return false;
  if (
    el.closest(
      '[role="dialog"][data-state="closed"], [role="alertdialog"][data-state="closed"]',
    ) !== null
  )
    return false;
  if (
    typeof el.checkVisibility === 'function' &&
    !el.checkVisibility({ checkVisibilityCSS: true })
  )
    return false;
  return true;
}

export function useFocusReturn({
  open,
  contentRef,
  fallback,
  initialFocus,
}: {
  open: boolean;
  contentRef: RefObject<HTMLElement | null>;
  /** Same-screen target when the opener is gone (read live at restore). */
  fallback?: RefObject<HTMLElement | null>;
  /** Where focus starts inside the content; absent keeps the primitive's
   *  own choice (e.g. AlertDialog's Cancel). */
  initialFocus?: () => HTMLElement | null;
}) {
  const registry = useContext(ModalLayerContext);
  const custody = useRef<Custody | null>(null);
  const latestOpen = useRef(open);
  latestOpen.current = open;
  const unmounted = useRef(false);
  const latestFallback = useRef(fallback);
  latestFallback.current = fallback;
  const latestInitial = useRef(initialFocus);
  latestInitial.current = initialFocus;
  trackActivation();

  const focusInitial = () => {
    const el = latestInitial.current?.();
    el?.focus({ preventScroll: true });
  };

  // Layout effect: runs before Radix's passive hideOthers, so the open-edge
  // release (outside focus → blur) happens before the background is
  // aria-hidden, and the capture happens before that blur. Captured once per
  // open generation — a StrictMode cleanup/replay keeps the opener.
  useLayoutEffect(() => {
    unmounted.current = false;
    const active = document.activeElement;
    const content = contentRef.current;
    if (open) {
      if (custody.current === null || custody.current.state !== 'open') {
        const previous = custody.current;
        const opener = captureOpener();
        if (previous !== null) {
          previous.state = 'done';
          custodies.delete(previous);
        }
        const next: Custody = {
          opener,
          content: () => contentRef.current,
          isOpen: () => latestOpen.current,
          // Reopened during its own exit: the same scope stays mounted and
          // its single close event now belongs to this generation.
          element: content,
          state: 'open',
          releasedFocus: false,
          pathname: window.location.pathname,
          contentSeen: content !== null,
        };
        custody.current = next;
        custodies.add(next);
        if (
          active instanceof HTMLElement &&
          active !== document.body &&
          !content?.contains(active)
        ) {
          active.blur();
        }
        // Reopened during its own exit: the content never unmounted, so no
        // new mount-autofocus comes — it is already shown, focus it here.
        if (content?.isConnected) focusInitial();
      }
    } else if (custody.current?.state === 'open') {
      custody.current.state = 'closing';
      // Release focus from inside: a layer opening in the same moment would
      // aria-hide this one around it.
      if (active instanceof HTMLElement && content?.contains(active)) {
        const closing = custody.current;
        closing.releasedFocus = true;
        // Same task only (see Custody.releasedFocus) — a boundary, not a delay.
        setTimeout(() => {
          closing.releasedFocus = false;
        }, 0);
        active.blur();
      }
    }
    return () => {
      unmounted.current = true;
    };
  }, [open]);

  useLayoutEffect(() => {
    // StrictMode's replay re-adds what its simulated unmount dropped.
    const live = custody.current;
    if (live !== null && live.state !== 'done') custodies.add(live);
    return () => {
      // Never mounted content: no close-autofocus will come to clean up.
      const c = custody.current;
      if (c !== null && !c.contentSeen) custodies.delete(c);
    };
  }, []);

  const onOpenAutoFocus = (e: Event) => {
    const c = custody.current;
    if (c !== null && c.state === 'open') {
      c.contentSeen = true;
      if (e.target instanceof Element) c.element = e.target;
    }
    if (latestInitial.current === undefined) return;
    e.preventDefault();
    focusInitial();
  };

  const onCloseAutoFocus = (e: Event) => {
    e.preventDefault();
    // The generation whose scope dispatched this — never a newer one that
    // opened (or opened and closed) before this late event ran.
    const current = custody.current;
    const c =
      current !== null &&
      (current.element === e.target ||
        (current.element === null && current.contentSeen))
        ? current
        : null;
    if (c === null) return;
    // StrictMode's FocusScope replay also lands here while still open.
    if (c.state === 'open' && latestOpen.current && !unmounted.current) return;
    const handedOn = c.state === 'done';
    c.state = 'done';
    custodies.delete(c);
    if (handedOn) return;
    if (window.location.pathname !== c.pathname) return;
    const active = document.activeElement;
    const free =
      active === null ||
      active === document.body ||
      contentRef.current?.contains(active) === true;
    if (!free) return;
    const top = registry?.top() ?? null;
    const target = [c.opener, latestFallback.current?.current ?? null].find(
      (el): el is HTMLElement =>
        isUsableFocusTarget(el) &&
        (top === null || top.element()?.contains(el) === true),
    );
    target?.focus({ preventScroll: true });
  };

  return { onOpenAutoFocus, onCloseAutoFocus };
}

/**
 * Focus while a layer is busy (issue #302): the operation in flight disables
 * the control that started it (and often everything else inside). The
 * browser then drops focus to the body, and Radix's trap has no enabled
 * element to put it back on, so the next Tab walks out through its focus
 * guards into the aria-hidden background. Keep it on the layer's own
 * container (Radix Content, tabIndex -1): Tab stays put while nothing inside
 * is enabled and resumes inside once the operation settles; a success close
 * still returns focus to the opener. Never takes focus from an enabled
 * control inside, or from anything focused outside the layer.
 */
export function useHoldFocusWhileBusy(
  busy: boolean,
  contentRef: RefObject<HTMLElement | null>,
): void {
  useLayoutEffect(() => {
    if (!busy) return;
    const content = contentRef.current;
    if (content === null || !content.isConnected) return;
    const active = document.activeElement;
    const dropped =
      active === null ||
      active === document.body ||
      (content.contains(active) &&
        active !== content &&
        active.matches(':disabled'));
    if (dropped) content.focus({ preventScroll: true });
  }, [busy, contentRef]);
}
