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

export type Channel =
  | 'upload'
  | 'telegram'
  | 'email'
  | 'drive'
  | 'ios_photo_library'
  | 'email_sync'
  | 'email_push';

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
  // Set at upload time when the document was paid out-of-pocket by a claimant.
  // Cleared by confirmPayment() if the approver decides it was not a personal expense.
  claimant_id: number | null;
  // Relative path to the rendered thumbnail (migration 060).
  // NULL = not yet rendered; triggers lazy fallback in the triage UI.
  preview_path: string | null;
}

export interface DocumentSource {
  id: number;
  document_id: number;
  channel: Channel;
  source_identifier: string | null;
  received_at: number;
  captured_at: number | null;
  precheck_json: string | null;
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
  // Unix seconds the asset was captured on-device (iOS). Optional.
  capturedAt?: number | null;
  // Raw JSON string of the on-device pre-check result. Optional.
  precheckJson?: string | null;
  // FK to entity.id — set when the document was paid out-of-pocket by a claimant.
  claimantId?: number | null;
}

export interface UploadDocumentResult {
  document: Document;
  deduplicated: boolean;
}
