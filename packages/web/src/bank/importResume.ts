import { SESSION_ID_KEY, TOKEN_KEY, currentSessionId } from '../auth';

/**
 * Bank-import resume pointer (issue #254). An accepted upload is observed at
 * `/bank/import?job=<id>` (the URL survives refresh and can be copied); this
 * per-tab pointer additionally makes a plain return to /bank/import resume
 * the tab's latest import — running or finished — until the operator
 * explicitly acknowledges it (New import / Try again / Open statement /
 * Forget).
 *
 * sessionStorage: scoped to the tab. The pointer records the sign-in's
 * random session id (auth.currentSessionId, never anything token-derived)
 * and is void under any other sign-in: sign-out, a 401, a new sign-in here
 * or in another tab. Every access is guarded — storage can be unavailable
 * or hold garbage; then there simply is no pointer.
 */
export const IMPORT_JOB_KEY = 'bk_bank_import_job';

/** A job id from the URL or storage: a positive safe integer, else null. */
export function parseJobId(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) return null;
  return parseJobId(Number(raw));
}

function remove(): void {
  try {
    sessionStorage.removeItem(IMPORT_JOB_KEY);
  } catch {
    // Storage unavailable: there is no pointer to remove.
  }
}

/** The tab's import job — only if it belongs to the current sign-in. */
export function readImportPointer(): number | null {
  let raw: string | null;
  let session: string | null;
  try {
    raw = sessionStorage.getItem(IMPORT_JOB_KEY);
    if (raw === null) return null;
    session = currentSessionId();
  } catch {
    return null;
  }
  let jobId: number | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      session !== null &&
      (parsed as { session?: unknown }).session === session
    ) {
      jobId = parseJobId((parsed as { jobId?: unknown }).jobId);
    }
  } catch {
    jobId = null;
  }
  if (jobId === null) remove();
  return jobId;
}

export function writeImportPointer(jobId: number): void {
  try {
    const session = currentSessionId();
    if (session === null) return;
    sessionStorage.setItem(IMPORT_JOB_KEY, JSON.stringify({ jobId, session }));
  } catch {
    // Storage unavailable: the URL still carries the job.
  }
}

/** The sign-in an observation belongs to (captured when it starts). */
export function importPointerOwner(): string | null {
  try {
    return currentSessionId();
  } catch {
    return null;
  }
}

/** Remember a job this tab observed through an explicit link — only while
 *  `owner` (the sign-in the observation started under) is still current,
 *  so an ended session's late outcome is never filed under the next one;
 *  and never over a job the tab already remembers (its own upload or an
 *  earlier link stays the one a return resumes). */
export function rememberImportPointer(jobId: number, owner: string | null) {
  if (owner === null || importPointerOwner() !== owner) return;
  if (readImportPointer() !== null) return;
  writeImportPointer(jobId);
}

/** Clear the pointer — only if it still names `jobId` when one is given
 *  (acknowledging an older job must not drop a newer job's pointer). */
export function clearImportPointer(jobId?: number): void {
  if (jobId !== undefined && readImportPointer() !== jobId) return;
  remove();
}

/** Another tab changed the sign-in (or cleared storage): this tab's
 *  pointer belongs to a session that is no longer current. Returns the
 *  unsubscribe. */
export function watchImportPointerSession(): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === TOKEN_KEY || e.key === SESSION_ID_KEY) {
      remove();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}
