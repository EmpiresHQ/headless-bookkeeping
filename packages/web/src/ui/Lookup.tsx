import { useState } from 'react';
import { Button } from './Button';

/**
 * Reference-data truth (issue #260): a list a form picks from is either
 * still loading, failed with nothing to show, an earlier success whose
 * refresh failed, or a fresh success. Only the last two are usable, and only
 * a fresh success proves that something is ABSENT — `data ?? []` made a
 * failed load look like a known-empty list.
 */
export type LookupState = 'loading' | 'error' | 'stale' | 'ready';

export type LookupQuery<T> = {
  data: T | undefined;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
};

export function lookupState(q: LookupQuery<unknown>): LookupState {
  if (q.data === undefined) return q.isError ? 'error' : 'loading';
  return q.isError ? 'stale' : 'ready';
}

/** A list that can be picked from (fresh or earlier success). */
export function lookupUsable(q: LookupQuery<unknown>): boolean {
  return q.data !== undefined;
}

/** Why a submit waits on this lookup (null once the list is usable). The
 *  notice next to the field carries the Retry. */
export function lookupBlocker(
  q: LookupQuery<unknown>,
  what: string,
): string | null {
  const state = lookupState(q);
  if (state === 'loading') return `Waiting for ${what} to load.`;
  if (state === 'error') return `Couldn't load ${what} — retry above.`;
  return null;
}

/** A usable but EMPTY category list (fresh, or the list loaded earlier) is
 *  a known state of its own — an expense needs a category, so it blocks. */
export const NO_CATEGORIES =
  'No expense categories are defined for this country — check the organization country in Settings.';

/** The first reason a submit is blocked, stated under the button. */
export function BlockedReason({ reason }: { reason: string | null }) {
  if (reason === null) return null;
  return (
    <p className="mt-1.5 text-center text-[12.5px] text-ink-2">{reason}</p>
  );
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Why a lookup cannot be relied on, with Retry — nothing when fresh. */
export function LookupNotice({
  query,
  what,
}: {
  query: LookupQuery<unknown>;
  /** Plural noun, e.g. "categories". */
  what: string;
}) {
  const state = lookupState(query);
  if (state === 'ready') return null;
  if (state === 'loading') {
    return (
      <p role="status" className="mt-1 text-[12.5px] text-ink-2">
        Loading {what}…
      </p>
    );
  }
  return (
    <div
      role="alert"
      className={`mt-1.5 rounded-xl px-3 py-2 text-[12.5px] ${
        state === 'error' ? 'bg-err-bg text-err' : 'bg-warn-bg text-warn'
      }`}
    >
      <p className="font-semibold">
        {state === 'error'
          ? `Couldn't load ${what} (${reason(query.error)}) — it is not known which exist.`
          : `Couldn't refresh ${what} (${reason(query.error)}) — showing the list loaded earlier.`}
      </p>
      <Button
        variant="secondary"
        className="mt-1.5 px-3 py-1.5 text-[13px]"
        onClick={() => void query.refetch()}
      >
        Retry {what}
      </Button>
    </div>
  );
}

type EntityPick<T> = { entity: T; created: boolean; at: number };

/**
 * A picked entity checked against its (role-filtered) list. A list pick is
 * judged by the list it came from: once a usable list lacks it (deleted, or
 * its role changed) the pick is `gone`. An entity the server just CREATED is
 * authoritative while the cached list predates it (an older omission proves
 * nothing), but a list successfully fetched AFTER the creation
 * (`dataUpdatedAt` past the pick) that lacks it makes it `gone` too. A failed
 * refetch keeps the older list and its timestamp, so it never flags a pick —
 * the LookupNotice warns instead. A gone pick stays shown and must be
 * corrected — never sent unseen.
 */
export function useEntityPick<T extends { id: number }>(q: {
  data: T[] | undefined;
  dataUpdatedAt: number;
}) {
  const [pick, setPick] = useState<EntityPick<T> | null>(null);
  const fresh =
    pick === null ? undefined : q.data?.find((e) => e.id === pick.entity.id);
  const gone =
    pick !== null &&
    q.data !== undefined &&
    fresh === undefined &&
    (!pick.created || q.dataUpdatedAt > pick.at);
  return {
    /** The picked entity as the list now knows it (else as picked). */
    entity: pick === null ? null : (fresh ?? pick.entity),
    gone,
    /** `created`: the server just returned it — call only after the
     *  creation's list invalidation settled, so no list fetch that started
     *  before the creation can land after `at`. */
    set: (entity: T | null, opts?: { created?: boolean }) =>
      setPick(
        entity === null
          ? null
          : { entity, created: opts?.created === true, at: Date.now() },
      ),
  };
}
