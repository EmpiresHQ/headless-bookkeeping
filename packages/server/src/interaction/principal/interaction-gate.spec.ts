// src/interaction/principal/interaction-gate.spec.ts
import { canConverse, canCommit, ingestDecision } from './interaction-gate';
import { Principal } from './types';

const approver = (authVerified: boolean): Principal => ({
  role: 'approver',
  authVerified,
  senderId: '999',
});
const known: Principal = {
  role: 'known_counterparty',
  authVerified: false,
  senderId: 's@x.com',
};
const unknown: Principal = {
  role: 'unknown',
  authVerified: false,
  senderId: 'x',
};

describe('InteractionGate', () => {
  it('lets only an approver converse', () => {
    expect(canConverse(approver(false))).toBe(true);
    expect(canConverse(known)).toBe(false);
    expect(canConverse(unknown)).toBe(false);
  });

  it('commits only for an authVerified approver', () => {
    expect(canCommit(approver(true))).toBe(true);
    expect(canCommit(approver(false))).toBe(false);
    expect(canCommit(unknown)).toBe(false);
  });

  it('accepts ingest from an approver or known counterparty regardless of policy', () => {
    expect(ingestDecision(approver(false), 'known-only')).toBe('accept');
    expect(ingestDecision(known, 'known-only')).toBe('accept');
  });

  it('gates unknown ingest by policy', () => {
    expect(ingestDecision(unknown, 'known-only')).toBe('reject');
    expect(ingestDecision(unknown, 'quarantine')).toBe('quarantine');
    expect(ingestDecision(unknown, 'open')).toBe('accept');
  });
});
