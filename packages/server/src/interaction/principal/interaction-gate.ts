// src/interaction/principal/interaction-gate.ts
import { IngestPolicy } from '../config/interaction-config.service';
import { Principal } from './types';

export type IngestDecision = 'accept' | 'quarantine' | 'reject';

/** Converse / take commands: approver only. */
export function canConverse(p: Principal): boolean {
  return p.role === 'approver';
}

/** Commit an Action point: approver AND transport-proven. */
export function canCommit(p: Principal): boolean {
  return p.role === 'approver' && p.authVerified;
}

/** Ingest an inbound document: known senders always; unknown by policy. */
export function ingestDecision(
  p: Principal,
  policy: IngestPolicy,
): IngestDecision {
  if (p.role === 'approver' || p.role === 'known_counterparty') return 'accept';
  if (policy === 'open') return 'accept';
  if (policy === 'quarantine') return 'quarantine';
  return 'reject';
}
