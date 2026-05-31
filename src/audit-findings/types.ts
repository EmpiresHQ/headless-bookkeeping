/** Severity levels for AuditFinding — drives SecretaryAgent nag cadence. */
export type FindingSeverity = 'low' | 'medium' | 'high' | 'critical';

/** Status of an AuditFinding. */
export type FindingStatus = 'open' | 'resolved' | 'snoozed';

/** Input for creating a new AuditFinding. */
export interface CreateAuditFindingDto {
  finding_type: string;
  severity: FindingSeverity;
  description: string;
  referenced_object_type?: string;
  referenced_object_id?: number;
}

/** Persisted AuditFinding record (ADR-0018). */
export interface AuditFinding {
  id: number;
  finding_type: string;
  severity: FindingSeverity;
  description: string;
  referenced_object_type: string | null;
  referenced_object_id: number | null;
  status: FindingStatus;
  created_at: number;
  resolved_at: number | null;
}
