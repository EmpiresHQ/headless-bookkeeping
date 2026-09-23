import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { SESSION_ID_KEY, TOKEN_KEY, currentSessionId } from '../auth';

/**
 * Durable operation results (issue #259). A toast is gone in seconds and a
 * form's partial-success notice dies with its screen; this log keeps what a
 * long or multi-stage operation RECORDED — which object, what outcome, where
 * to continue — across route changes and a reload of the tab.
 *
 * One entry per operation CHAIN: it is created when the chain's first stage
 * is accepted by the server and every later stage (and an in-memory retry)
 * updates the same entry, so a finished retry supersedes its earlier partial
 * outcome. It is a client RECEIPT, never live status: it says what was
 * recorded and when, and links to the authoritative object.
 *
 * sessionStorage, bound to the sign-in's random session id (auth.
 * currentSessionId): another sign-in never sees it, sign-out and another
 * tab's sign-in/out clear it. Only ids, names and text are stored — never a
 * token or a file. Storage can be unavailable or hold garbage: then the log
 * lives in memory for this page and says so. Bounded; entries leave only by
 * explicit dismiss (or by falling off the end).
 */
export const RESULT_LOG_KEY = 'bk_operation_results';
const MAX_ENTRIES = 8;
const MAX_TEXT = 300;
const MAX_LINKS = 4;

/** `pending`: accepted and waiting for someone else (an approval). */
export type ResultTone =
  | 'ok'
  | 'pending'
  | 'partial'
  | 'warn'
  | 'error'
  | 'running';

export interface ResultLink {
  label: string;
  /** In-app path. */
  to: string;
}

export interface ResultInit {
  /** What was done: "Upload", "Create & match", "Approve"… */
  action: string;
  /** The object it was done to, by its real name/id. */
  title: string;
  /** The recorded outcome, in words. */
  outcome: string;
  tone: ResultTone;
  links: ResultLink[];
  /** A key a screen can look its own record up by (e.g. a bank line). */
  subject?: string;
}

export interface ResultEntry extends ResultInit {
  id: string;
  /** When the outcome was recorded (ms). */
  at: number;
  /** A `running` entry's page instance — another page's is interrupted. */
  page?: string;
  /** The page was reloaded while this chain was running. */
  interrupted?: boolean;
}

/** One page load of the app: a `running` entry stamped by an earlier page
 *  cannot still be running (its continuation died with that page). */
const PAGE_ID =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

let seq = 0;
const newId = () =>
  `${PAGE_ID.slice(0, 8)}-${Date.now().toString(36)}-${++seq}`;

const TONES: readonly string[] = [
  'ok',
  'pending',
  'partial',
  'warn',
  'error',
  'running',
];

const clip = (s: string) =>
  s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s;

/** An in-app path only: never another origin or a scheme. */
function safePath(to: unknown): to is string {
  return (
    typeof to === 'string' &&
    to.startsWith('/') &&
    !to.startsWith('//') &&
    !to.includes('\\') &&
    to.length <= 512
  );
}

function cleanLinks(raw: unknown): ResultLink[] | null {
  if (!Array.isArray(raw)) return null;
  const links: ResultLink[] = [];
  for (const l of raw.slice(0, MAX_LINKS)) {
    if (
      typeof l !== 'object' ||
      l === null ||
      typeof (l as ResultLink).label !== 'string' ||
      !safePath((l as ResultLink).to)
    ) {
      return null;
    }
    links.push({
      label: clip((l as ResultLink).label),
      to: (l as ResultLink).to,
    });
  }
  return links;
}

/** A stored entry, validated — or null (a corrupt entry is dropped alone). */
export function parseEntry(raw: unknown): ResultEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as Record<string, unknown>;
  const links = cleanLinks(e.links);
  if (
    typeof e.id !== 'string' ||
    typeof e.at !== 'number' ||
    !Number.isFinite(e.at) ||
    typeof e.action !== 'string' ||
    typeof e.title !== 'string' ||
    typeof e.outcome !== 'string' ||
    typeof e.tone !== 'string' ||
    !TONES.includes(e.tone) ||
    links === null ||
    (e.subject !== undefined && typeof e.subject !== 'string') ||
    (e.page !== undefined && typeof e.page !== 'string')
  ) {
    return null;
  }
  return {
    id: e.id,
    at: e.at,
    action: clip(e.action),
    title: clip(e.title),
    outcome: clip(e.outcome),
    tone: e.tone as ResultTone,
    links,
    ...(e.subject !== undefined ? { subject: e.subject as string } : {}),
    ...(e.page !== undefined ? { page: e.page as string } : {}),
    ...(e.interrupted === true ? { interrupted: true } : {}),
  };
}

/** A running entry of an earlier page load: its chain can no longer be
 *  running here, and its final outcome is unknown to this page. */
function settleInterrupted(e: ResultEntry): ResultEntry {
  if (e.tone !== 'running' || e.page === PAGE_ID) return e;
  const { page: _page, ...rest } = e;
  return { ...rest, tone: 'warn', interrupted: true };
}

/** The stored log of `session`, or [] (other sign-in, garbage, no storage). */
export function readResultLog(session: string | null): ResultEntry[] {
  if (session === null) return [];
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(RESULT_LOG_KEY);
  } catch {
    return [];
  }
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as {
      v?: unknown;
      session?: unknown;
      entries?: unknown;
    };
    if (
      parsed?.v === 1 &&
      parsed.session === session &&
      Array.isArray(parsed.entries)
    ) {
      return parsed.entries
        .map(parseEntry)
        .filter((e): e is ResultEntry => e !== null)
        .slice(0, MAX_ENTRIES)
        .map(settleInterrupted);
    }
  } catch {
    // Garbage: fall through and drop it.
  }
  clearResultLog();
  return [];
}

/** Returns false when storage refused the write. */
function writeResultLog(session: string, entries: ResultEntry[]): boolean {
  try {
    sessionStorage.setItem(
      RESULT_LOG_KEY,
      JSON.stringify({ v: 1, session, entries }),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearResultLog(): void {
  try {
    sessionStorage.removeItem(RESULT_LOG_KEY);
  } catch {
    // Unavailable storage holds no log.
  }
}

function sessionOrNull(): string | null {
  try {
    return currentSessionId();
  } catch {
    return null;
  }
}

/** Another tab signed in/out (or cleared storage): this tab's log belongs
 *  to a session that is no longer current. Returns the unsubscribe. */
export function watchResultLogSession(onEnded?: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === TOKEN_KEY || e.key === SESSION_ID_KEY) {
      clearResultLog();
      onEnded?.();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}

/** A recorded chain: later stages update THIS entry (re-adding it if the
 *  operator dismissed an earlier stage — the final outcome still matters).
 *  `live` (an operation's ctx.live) is checked on every write. */
export interface ResultHandle {
  /** False when the write was dropped (ended generation or scope). */
  update: (patch: Partial<ResultInit>, live?: () => boolean) => boolean;
}

export interface ResultLog {
  entries: ResultEntry[];
  /** False when this page's results cannot be kept across a reload. */
  persistent: boolean;
  record: (init: ResultInit, live?: () => boolean) => ResultHandle;
  dismiss: (id: string) => void;
  clear: () => void;
}

const NOOP_HANDLE: ResultHandle = { update: () => false };
const NOOP_LOG: ResultLog = {
  entries: [],
  persistent: false,
  record: () => NOOP_HANDLE,
  dismiss: () => undefined,
  clear: () => undefined,
};

const ResultLogContext = createContext<ResultLog>(NOOP_LOG);

export function useResultLog(): ResultLog {
  return useContext(ResultLogContext);
}

/** Where a component keeps a chain's handle between stages and retries:
 *  tagged with the generation (`record`) that created it. */
export type ChainSlot = {
  current: { record: ResultLog['record']; handle: ResultHandle } | null;
};

/**
 * Write a chain's next stage to the handle kept in `slot` — only if that
 * handle belongs to the caller's own generation (`record`, from the render
 * the operation started in) and can still write; otherwise start a new
 * entry with `record` (which refuses if it is itself stale). So an old
 * closure never touches a newer generation's entry, and a retry after a
 * rebind records under the new one.
 */
export function writeChain(
  slot: ChainSlot,
  record: ResultLog['record'],
  init: ResultInit,
  live?: () => boolean,
): void {
  const held = slot.current;
  if (held !== null && held.record === record && held.handle.update(init, live))
    return;
  if (held !== null && held.record !== record) {
    // Another generation's handle: never written by this closure.
    const handle = record(init, live);
    if (handle !== NOOP_HANDLE) slot.current = { record, handle };
    return;
  }
  slot.current = { record, handle: record(init, live) };
}

/** A handle view of a slot, for continuations (Undo) of the same chain. */
export function slotHandle(slot: ChainSlot): ResultHandle | null {
  return slot.current?.handle ?? null;
}

/**
 * A screen's receipt for one repeatable action (issue #259): the same
 * `key` again — a retry of the same action on the same object — supersedes
 * the earlier outcome (e.g. its failure) instead of adding an entry. The
 * cache belongs to the log generation it was rendered in, so an old
 * closure only ever touches its own generation's handles.
 */
export function useReceipt(): (
  key: string,
  init: ResultInit,
  live?: () => boolean,
) => ResultHandle {
  const { record } = useResultLog();
  return useMemo(() => {
    const last: { key: string | null; slot: ChainSlot } = {
      key: null,
      slot: { current: null },
    };
    return (key: string, init: ResultInit, live?: () => boolean) => {
      if (last.key !== key) {
        last.key = key;
        last.slot = { current: null };
      }
      writeChain(last.slot, record, init, live);
      return last.slot.current?.handle ?? NOOP_HANDLE;
    };
  }, [record]);
}

/** The newest recorded entry about `subject`, if any. */
export function useRecordedFor(subject: string): ResultEntry | null {
  const { entries } = useResultLog();
  return entries.find((e) => e.subject === subject) ?? null;
}

/** One ownership period of the log: a session id, and which rebind. */
interface Generation {
  readonly n: number;
  readonly session: string | null;
}

/**
 * Lives with the authenticated shell (one per sign-in, like the
 * QueryClient). The log belongs to a GENERATION — one session id. Another
 * tab's sign-in/out (storage event), or any write that finds a different
 * current session id, starts a new generation with an empty log: this
 * tab's shell may stay mounted, and operations rendered from then on
 * record under the new generation. `record`, `dismiss`, `clear` and every
 * handle are bound to the generation they were rendered/created in, so a
 * continuation of an older one — even a delayed FIRST record after a
 * same-token sign-in elsewhere — never writes into the new log.
 */
export function ResultLogProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(() => {
    const session = sessionOrNull();
    return { gen: { n: 0, session }, entries: readResultLog(session) };
  });
  const [gen, setGen] = useState<Generation>(initial.gen);
  const genRef = useRef<Generation>(initial.gen);
  const current = useRef<ResultEntry[]>(initial.entries);
  const [entries, setEntries] = useState<ResultEntry[]>(initial.entries);
  const [persistent, setPersistent] = useState(initial.gen.session !== null);
  const mounted = useRef(false);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const rebind = useCallback(() => {
    const next = { n: genRef.current.n + 1, session: sessionOrNull() };
    genRef.current = next;
    current.current = [];
    setGen(next);
    setEntries([]);
    setPersistent(next.session !== null);
  }, []);

  /** May `g` still write? Only while it is the current generation and its
   *  session is the current sign-in (else a new generation starts). */
  const owns = useCallback(
    (g: Generation): boolean => {
      if (!mounted.current || genRef.current !== g) return false;
      if (sessionOrNull() !== g.session) {
        rebind();
        return false;
      }
      return g.session !== null;
    },
    [rebind],
  );

  const commit = useCallback((g: Generation, next: ResultEntry[]) => {
    current.current = next.slice(0, MAX_ENTRIES);
    setEntries(current.current);
    if (g.session !== null)
      setPersistent(writeResultLog(g.session, current.current));
  }, []);

  // An interrupted chain found at load is settled in storage too — only
  // while the log still belongs to the generation it was read under.
  useEffect(() => {
    if (owns(initial.gen) && current.current.length > 0) {
      commit(initial.gen, current.current);
    }
  }, [owns, commit, initial.gen]);

  // The stored log is already cleared by the watcher; start a generation
  // for whatever sign-in is current now (none when signed out).
  useEffect(() => watchResultLogSession(rebind), [rebind]);

  const record = useCallback(
    (init: ResultInit, live?: () => boolean): ResultHandle => {
      if (!owns(gen) || (live !== undefined && !live())) return NOOP_HANDLE;
      const id = newId();
      const build = (base: ResultInit): ResultEntry => {
        const links =
          cleanLinks(base.links.filter((l) => safePath(l.to))) ?? [];
        return {
          id,
          at: Date.now(),
          action: clip(base.action),
          title: clip(base.title),
          outcome: clip(base.outcome),
          tone: base.tone,
          links,
          ...(base.subject !== undefined ? { subject: base.subject } : {}),
          ...(base.tone === 'running' ? { page: PAGE_ID } : {}),
        };
      };
      let last: ResultInit = init;
      commit(gen, [build(init), ...current.current]);
      return {
        update: (patch, liveNow) => {
          // The handle's own generation only — never a newer one's log.
          if (!owns(gen) || (liveNow !== undefined && !liveNow())) return false;
          last = { ...last, ...patch };
          // The newest stage of a chain goes to the top.
          commit(gen, [
            build(last),
            ...current.current.filter((e) => e.id !== id),
          ]);
          return true;
        },
      };
    },
    [gen, owns, commit],
  );

  const dismiss = useCallback(
    (id: string) => {
      if (owns(gen))
        commit(
          gen,
          current.current.filter((e) => e.id !== id),
        );
    },
    [gen, owns, commit],
  );
  const clear = useCallback(() => {
    if (owns(gen)) commit(gen, []);
  }, [gen, owns, commit]);

  const value = useMemo(
    () => ({ entries, persistent, record, dismiss, clear }),
    [entries, persistent, record, dismiss, clear],
  );
  return (
    <ResultLogContext.Provider value={value}>
      {children}
    </ResultLogContext.Provider>
  );
}

/** "14:02", or "12 Sep 14:02" when not today. */
export function recordedAt(at: number, now = Date.now()): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
  return new Date(now).toDateString() === d.toDateString()
    ? time
    : `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}

/** Stage text of a running entry that a reload interrupted. */
export function interruptedText(outcome: string): string {
  return `Interrupted by a page reload. Last recorded stage: ${outcome} The final outcome is unknown here — open the item for its current state; nothing was repeated.`;
}
