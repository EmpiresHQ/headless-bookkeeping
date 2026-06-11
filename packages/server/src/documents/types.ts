/**
 * Document lifecycle status — the kernel-owned state machine for an intake
 * Document (ADR-0010, ADR-0024).
 *
 *   pending ─┬─▶ triaged       (a confident draft was proposed)
 *            └─▶ needs_triage  (routed to a human via AuditFinding)
 *   triaged       ──▶ processed (operator marked the intake complete)
 *   needs_triage  ──▶ triaged   (a human re-triaged into a draft)
 *
 * The transition is owned by the single deep owner of "Document -> outcome"
 * (IntakeWorkflowService); see ADR-0024. `needs_triage` is a first-class
 * Document status (a human resolves it by re-running the workflow), distinct
 * from the AuditFinding's own `needs_triage` finding_type.
 */
export type DocumentStatus =
  | 'pending'
  | 'triaged'
  | 'needs_triage'
  | 'processed'
  | 'error';

export type Channel = 'upload' | 'telegram' | 'email' | 'drive';

export interface Document {
  id: number;
  hash: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string | null;
  status: DocumentStatus;
  // Unix seconds — set when intake workflow starts processing; cleared on
  // completion. NULL = idle (not currently in the intake pipeline).
  processing_since: number | null;
  created_at: number;
}

export interface DocumentSource {
  id: number;
  document_id: number;
  channel: Channel;
  source_identifier: string | null;
  received_at: number;
}

export interface DocumentWithSources extends Document {
  sources: DocumentSource[];
}

export interface UploadDocumentInput {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  channel: Channel;
  sourceIdentifier?: string | null;
}

export interface UploadDocumentResult {
  document: Document;
  deduplicated: boolean;
}
