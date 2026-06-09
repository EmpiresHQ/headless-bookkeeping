/** Severity levels for AuditFinding — drives SecretaryAgent nag cadence. */
export type FindingSeverity = 'low' | 'medium' | 'high' | 'critical';

/** The canonical, ranked severity set (low → critical). */
export const FINDING_SEVERITIES: readonly FindingSeverity[] = [
  'low',
  'medium',
  'high',
  'critical',
] as const;

/**
 * The known kinds of AuditFinding (ADR-0018). The AuditAgent (and the intake
 * pipeline) only ever materializes one of these; the SecretaryAgent branches
 * its nag behavior on the kind. Making this a closed enum is the core of the
 * deepening: the buffer now carries enough typed structure for the Secretary
 * to act per-kind instead of flattening everything into one nag.
 */
export type FindingType =
  | 'needs_triage' // intake could not classify / confidence too low
  | 'missing_receipt' // an expense without its backing Document
  | 'deadline_approaching' // a VAT filing / Reporting period deadline nears
  | 'pending_approval' // a Policy-held Approval awaiting a human decision
  | 'policy_hold' // a draft held by Policy (unresolved treatment)
  | 'unmatched_bank_line' // a bank statement line with no ReconciliationMatch
  | 'aging_invoice' // an unpaid Receivable past due
  | 'personal_repayment' // an outstanding personal-disposition repayment
  | 'anomaly'; // a generic ledger anomaly the AuditAgent flagged

/** The canonical set of known finding kinds. */
export const FINDING_TYPES: readonly FindingType[] = [
  'needs_triage',
  'missing_receipt',
  'deadline_approaching',
  'pending_approval',
  'policy_hold',
  'unmatched_bank_line',
  'aging_invoice',
  'personal_repayment',
  'anomaly',
] as const;

/**
 * The kinds of business object an AuditFinding can reference. Validated so a
 * finding cannot dangle against an un-typed string.
 */
export type ReferencedObjectType =
  | 'document'
  | 'expense'
  | 'sales_invoice'
  | 'approval'
  | 'voucher'
  | 'bank_statement_line'
  | 'reconciliation_match'
  | 'reporting_period'
  | 'entity';

/** The canonical set of referenceable object types. */
export const REFERENCED_OBJECT_TYPES: readonly ReferencedObjectType[] = [
  'document',
  'expense',
  'sales_invoice',
  'approval',
  'voucher',
  'bank_statement_line',
  'reconciliation_match',
  'reporting_period',
  'entity',
] as const;

/** Status of an AuditFinding — the lifecycle state of the buffer entry. */
export type FindingStatus = 'open' | 'resolved' | 'snoozed';

/** The canonical set of statuses. */
export const FINDING_STATUSES: readonly FindingStatus[] = [
  'open',
  'resolved',
  'snoozed',
] as const;

/**
 * The explicit lifecycle state machine for an AuditFinding. Each key is a
 * current status; the value is the set of statuses it may legally transition
 * to. A blind UPDATE is replaced by a guarded transition that consults this
 * map. `resolved` is terminal (a re-detected issue is a NEW finding, not a
 * resurrected one).
 */
export const FINDING_TRANSITIONS: Record<
  FindingStatus,
  readonly FindingStatus[]
> = {
  open: ['resolved', 'snoozed'],
  snoozed: ['open', 'resolved'],
  resolved: [],
} as const;

/** Input for creating a new AuditFinding. */
export interface CreateAuditFindingDto {
  finding_type: FindingType;
  severity: FindingSeverity;
  description: string;
  referenced_object_type?: ReferencedObjectType;
  referenced_object_id?: number;
}

/** Persisted AuditFinding record (ADR-0018). */
export interface AuditFinding {
  id: number;
  finding_type: FindingType;
  severity: FindingSeverity;
  description: string;
  referenced_object_type: ReferencedObjectType | null;
  referenced_object_id: number | null;
  status: FindingStatus;
  created_at: number;
  resolved_at: number | null;
  /** When the finding was last snoozed (audit trail). */
  snoozed_at: number | null;
  /** Who triggered the last lifecycle transition (audit trail). */
  transitioned_by: string | null;
  /** Why the last lifecycle transition happened (audit trail). */
  transition_reason: string | null;
}

/** Optional attribution for a guarded lifecycle transition. */
export interface TransitionContext {
  by?: string;
  reason?: string;
}

/** Thrown when a lifecycle transition is not permitted by the state machine. */
export class InvalidFindingTransitionError extends Error {
  constructor(
    public readonly from: FindingStatus,
    public readonly to: FindingStatus,
  ) {
    super(
      `Invalid AuditFinding transition: ${from} -> ${to}. ` +
        `Allowed from "${from}": ${
          FINDING_TRANSITIONS[from].length
            ? FINDING_TRANSITIONS[from].join(', ')
            : '(none — terminal)'
        }.`,
    );
    this.name = 'InvalidFindingTransitionError';
  }
}

/** True if `to` is a legal next status from `from`. */
export function canTransition(from: FindingStatus, to: FindingStatus): boolean {
  return FINDING_TRANSITIONS[from].includes(to);
}
