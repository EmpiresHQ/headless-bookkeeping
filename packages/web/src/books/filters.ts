import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { ORDER_PARAMS, type OrderSemantics } from './listOrder';

/** Params owned by individual segments — dropped on segment switch (a Draft
 *  filter has no meaning on Documents); ?q= survives. */
export const SEGMENT_PARAMS = ['status', 'nodoc', 'dstatus'] as const;

/** What each segment's search matches (issue #276) — the wording mirrors the
 *  segment's actual predicate, never more: Documents and Credit notes are
 *  not searched by amount. `scope` is shown next to an active search and is
 *  the input's description, since the placeholder is gone once typed in. */
export const BOOKS_SEARCH = {
  expenses: {
    noun: 'expenses',
    placeholder: 'Supplier, invoice no., category, amount…',
    scope: 'supplier, invoice number, category or amount',
  },
  invoices: {
    noun: 'invoices',
    placeholder: 'Customer, invoice number, amount…',
    scope: 'customer, invoice number or amount',
  },
  documents: {
    noun: 'documents',
    placeholder: 'File name or supplier…',
    scope: 'file name or supplier',
  },
  'credit-notes': {
    noun: 'credit notes',
    placeholder: 'Note number, counterparty, invoice number, category…',
    scope:
      'credit note number, credited customer or supplier, invoice number or expense category',
  },
} as const;

/** Date field + order support per segment (issue #279): the date each
 *  segment actually filters on, named in the controls and the ActiveFilters
 *  line. Documents carry no amount — no amount order is offered there. */
export const BOOKS_ORDER: Record<
  keyof typeof BOOKS_SEARCH,
  OrderSemantics & { dateField: string }
> = {
  expenses: {
    dateNoun: 'Tax point',
    dateField: 'tax point date',
    amounts: true,
    noun: 'expenses',
  },
  invoices: {
    dateNoun: 'Tax point',
    dateField: 'tax point date',
    amounts: true,
    noun: 'invoices',
  },
  documents: {
    dateNoun: 'Added',
    dateField: 'date added',
    amounts: false,
    noun: 'documents',
  },
  'credit-notes': {
    dateNoun: 'Tax point',
    dateField: 'tax point date',
    amounts: true,
    noun: 'credit notes',
  },
};

/** Books' Reset accessible name — what it actually clears (the shared
 *  ActiveFilters default stays for Inbox/Bank). */
export const BOOKS_RESET_NAME = 'Reset filters, search, dates and order';

/** The URL after Reset (issue #274): the segment filters, the search AND
 *  the date range + order (#279) go;
 *  ?seg=, every unrelated param and the history state stay. A lingering
 *  legacy ?tab= is normalized to ?seg=<the segment on screen>, as useSeg
 *  does on arrival. */
export function resetFilterParams(
  params: URLSearchParams,
  segment: string,
): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of SEGMENT_PARAMS) next.delete(key);
  for (const key of ORDER_PARAMS) next.delete(key);
  next.delete('q');
  if (next.has('tab')) {
    next.delete('tab');
    next.set('seg', segment);
  }
  return next;
}

/** Reset for the segment on screen: replace-history (a filter change is not a
 *  navigation) and the entry's own state is kept (origin record, #252). */
export function useResetFilters(segment: string): () => void {
  const [params, setParams] = useSearchParams();
  const { state } = useLocation();
  const signalReset = useContext(BooksResetSignal);
  return () => {
    setParams(resetFilterParams(params, segment), {
      replace: true,
      state: state as unknown,
    });
    signalReset();
  };
}

/** Told on every Reset (issue #279): the native date inputs clear an
 *  incomplete entry that never reached the URL, which a URL diff cannot
 *  show. Provided by BooksScreen; a no-op elsewhere. */
export const BooksResetSignal = createContext<() => void>(() => undefined);

/** Filter write for a segment: set/delete one param, replace-history, the
 *  entry's state kept (as Reset and useSeg do). */
export function useSetFilterParam(): (
  key: string,
  value: string | null,
) => void {
  const [params, setParams] = useSearchParams();
  const { state } = useLocation();
  return (key, value) => {
    const next = new URLSearchParams(params);
    if (value === null) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true, state: state as unknown });
  };
}

/** Reset + where focus lands afterwards. The bar holding the Reset button
 *  unmounts with the restrictions, so focus moves to the now-active first
 *  chip ("All") of the segment's strip, or to the segment container when no
 *  strip is on screen (loading/error, Credit notes; the container starts
 *  right under the search field, so it is on screen). Only after a click —
 *  never on refetch. */
export function useResetWithFocus(segment: string): {
  rootRef: RefObject<HTMLDivElement>;
  onReset: () => void;
} {
  const reset = useResetFilters(segment);
  const rootRef = useRef<HTMLDivElement>(null);
  const [focusPending, setFocusPending] = useState(false);
  useEffect(() => {
    if (!focusPending) return;
    setFocusPending(false);
    const root = rootRef.current;
    const strip = root?.querySelector<HTMLElement>('[data-filter-strip]');
    // "All" is the strip's first chip: bring it back into the strip's own
    // view (the user may have scrolled the strip right) — horizontal only,
    // the page/Sheet does not move.
    if (strip) strip.scrollLeft = 0;
    const target = strip?.querySelector<HTMLElement>('button') ?? root;
    target?.focus({ preventScroll: true });
  }, [focusPending]);
  return {
    rootRef,
    onReset: () => {
      reset();
      setFocusPending(true);
    },
  };
}
