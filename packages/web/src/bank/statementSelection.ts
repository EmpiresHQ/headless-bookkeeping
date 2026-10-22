import { currentSessionId, storedAuthEpoch } from '../auth';

/** Explicit choices belong to this history entry and sign-in, including
 * an empty set (the operator deselected the high-confidence defaults). */
export function restoredStatementSelection(
  state: unknown,
  statementId: number,
): Set<string> | null {
  if (!state || typeof state !== 'object' || !('statementSelection' in state))
    return null;
  const saved = state.statementSelection;
  if (
    !saved ||
    typeof saved !== 'object' ||
    !('statementId' in saved) ||
    saved.statementId !== statementId ||
    !('sessionId' in saved) ||
    saved.sessionId !== currentSessionId() ||
    !('epoch' in saved) ||
    saved.epoch !== storedAuthEpoch() ||
    !('keys' in saved) ||
    !Array.isArray(saved.keys) ||
    !saved.keys.every((key): key is string => typeof key === 'string')
  )
    return null;
  return new Set(saved.keys);
}

export function statementSelectionState(
  statementId: number,
  keys: Set<string>,
) {
  return {
    statementId,
    sessionId: currentSessionId(),
    epoch: storedAuthEpoch(),
    keys: [...keys],
  };
}
