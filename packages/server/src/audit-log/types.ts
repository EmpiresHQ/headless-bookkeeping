// src/audit-log/types.ts
/** One action / access decision to record. `detail` is serialized to JSON. */
export interface AuditEntry {
  actor: string;
  action: string;
  outcome: string;
  target_type?: string | null;
  target_id?: number | null;
  detail?: Record<string, unknown> | null;
}
