import { useSearchParams } from 'react-router-dom';

/**
 * Shared ?seg= segment state with the legacy ?tab= alias (bookmarks from
 * the old tabbed Settings shell). Extracted in Plan 06 on the third
 * consumer (P05 Appendix B):
 * InboxScreen, BooksScreen, settings/EntitiesScreen.
 * Read: ?seg= wins, ?tab= is the alias, anything unknown → fallback.
 * Write: sets ?seg=, deletes ?tab= and the segment-scoped `clear` params,
 * PRESERVES everything else (?q= survives a Books segment switch),
 * replace-history (a segment flick is not a navigation).
 */
export function useSeg<T extends string>(
  segments: readonly T[],
  fallback: T,
  clear: readonly string[] = [],
): [T, (next: T) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get('seg') ?? params.get('tab');
  const seg = segments.includes(raw as T) ? (raw as T) : fallback;
  const setSeg = (next: T) => {
    const p = new URLSearchParams(params);
    p.set('seg', next);
    p.delete('tab');
    for (const key of clear) p.delete(key);
    setParams(p, { replace: true });
  };
  return [seg, setSeg];
}
