import { useEffect, useRef, useState } from 'react';
import { checkToken, isSameSession, sessionStamp, setToken } from '../auth';
import { Button } from '../ui/Button';

/** Why the gate is showing (issue #285) — decided by Root, never by a
 *  response text. `ended` is a 401 of access that had been accepted: the
 *  server does not say why (revoked, replaced or expired look the same). */
export type GateReason = 'first' | 'signed-out' | 'ended' | 'elsewhere';

/** The outcome of this gate's own sign-in attempt. */
type Attempt = 'idle' | 'checking' | 'rejected' | 'unavailable' | 'interrupted';

const REASONS: Record<GateReason, { title: string; text: string }> = {
  first: {
    title: 'Sign in',
    text: 'Paste an API token. It is stored in this browser only.',
  },
  'signed-out': {
    title: 'Signed out',
    text: 'You signed out. Paste an API token to sign in again.',
  },
  ended: {
    title: 'Access ended',
    text: 'The server no longer accepts the token this browser was using. It may have been revoked, replaced or expired. Paste a current token to continue.',
  },
  elsewhere: {
    title: 'Signed out',
    text: 'You were signed out in another tab of this browser. Paste an API token to continue.',
  },
};

const ATTEMPTS: Record<'rejected' | 'unavailable' | 'interrupted', string> = {
  rejected:
    'That token was not accepted. Check that it was copied in full, or ask for a new one.',
  unavailable:
    'Could not verify access right now. Nothing was saved — try again.',
  interrupted:
    'The sign-in changed in another tab while this token was being checked. Nothing was saved — sign in again.',
};

/**
 * Full-screen token entry shown when no token is stored (or after a 401).
 * A token is checked before it is stored (auth.checkToken): only an
 * accepted one signs in; a rejected one and an unanswered check stay here
 * with the masked value kept for correction or retry. The route is never
 * touched, so the address the operator came to opens after sign-in.
 */
export function TokenGate({
  reason,
  storageEpoch,
  onSaved,
}: {
  reason: GateReason;
  /** Moves whenever Root observes another tab touching the sign-in. */
  storageEpoch: number;
  onSaved: () => void;
}) {
  const [value, setValue] = useState('');
  const [attempt, setAttempt] = useState<Attempt>('idle');
  // The check in flight — set synchronously, so a same-tick second submit
  // sends nothing; replaced/cleared when it is cancelled or the gate goes.
  const inFlight = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      inFlight.current?.abort();
      inFlight.current = null;
    },
    [],
  );
  // Another tab signed in or out (even if storage ended up as it was): a
  // check started before that is void — released at once, never waited on.
  const seenEpoch = useRef(storageEpoch);
  useEffect(() => {
    if (seenEpoch.current === storageEpoch) return;
    seenEpoch.current = storageEpoch;
    if (inFlight.current === null) return;
    inFlight.current.abort();
    inFlight.current = null;
    setAttempt('interrupted');
  }, [storageEpoch]);

  const submit = async () => {
    const token = value.trim();
    if (token.length === 0 || inFlight.current !== null) return;
    const check = new AbortController();
    inFlight.current = check;
    const startedAt = sessionStamp();
    setAttempt('checking');
    let result: Awaited<ReturnType<typeof checkToken>>;
    try {
      result = await checkToken(token, check.signal);
    } catch {
      return; // Aborted: whoever aborted it owns the state now.
    }
    if (inFlight.current !== check) return;
    inFlight.current = null;
    // Another tab signed in meanwhile: that sign-in is current (Root
    // adopts it) — this attempt stores nothing over it.
    if (!isSameSession(startedAt)) {
      setAttempt('interrupted');
      return;
    }
    if (result === 'accepted') {
      setToken(token);
      onSaved();
      return;
    }
    setAttempt(result);
  };

  const cancel = () => {
    inFlight.current?.abort();
    inFlight.current = null;
    setAttempt('idle');
  };

  const checking = attempt === 'checking';
  const { title, text } = REASONS[reason];
  const problem =
    attempt === 'idle' || attempt === 'checking' ? null : ATTEMPTS[attempt];

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg p-4 text-ink">
      <form
        className="bg-surface p-6 rounded-lg shadow w-full max-w-sm space-y-4"
        aria-labelledby="token-gate-title"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h1 id="token-gate-title" className="text-[17px] font-semibold">
          {title}
        </h1>
        <p className="text-sm text-ink-2">{text}</p>
        <input
          className="w-full border border-line rounded px-3 py-2 font-mono text-sm min-h-[44px] read-only:opacity-60"
          type="password"
          placeholder="token"
          aria-label="API token"
          aria-invalid={attempt === 'rejected' || undefined}
          aria-describedby={problem ? 'token-gate-problem' : undefined}
          autoComplete="off"
          value={value}
          readOnly={checking}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
        <p
          id="token-gate-problem"
          role="alert"
          className={
            problem ? 'rounded bg-err-bg px-3 py-2 text-sm text-err' : 'sr-only'
          }
        >
          {problem}
        </p>
        <Button
          type="submit"
          className="w-full"
          busy={checking}
          pendingLabel="Checking the token…"
        >
          {attempt === 'unavailable' ? 'Try again' : 'Sign in'}
        </Button>
        {checking && (
          <Button variant="ghost" className="w-full" onClick={cancel}>
            Cancel
          </Button>
        )}
        {/* Who issues access (issue #286): tokens are created by whoever
            administers this installation — there is no self-service signup. */}
        <p className="border-t border-line pt-4 text-sm text-ink-2">
          No token? Ask the person who runs this bookkeeping system. They create
          access tokens and can give you one.
        </p>
      </form>
    </div>
  );
}
