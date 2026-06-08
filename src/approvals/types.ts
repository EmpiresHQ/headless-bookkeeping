/**
 * Approval status enum — matches the CHECK constraint in the approval table.
 *
 * States: pending → approved | rejected | superseded
 * Never auto-resolves (ADR-0012).
 */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'superseded';

/**
 * Business object types that can be held for approval.
 */
export type ApprovalObjectType = 'expense' | 'sales_invoice';

/**
 * A persisted approval record — a Rules-valid submission held by Policy
 * for a human decision.
 */
export interface Approval {
  id: number;
  object_type: ApprovalObjectType;
  object_id: number;
  status: ApprovalStatus;
  requested_by: string;
  approved_by: string | null;
  rejected_reason: string | null;
  superseded_by: number | null;
  created_at: number;
  resolved_at: number | null;
}

/**
 * DTO for creating a new approval.
 */
export interface CreateApprovalDto {
  object_type: ApprovalObjectType;
  object_id: number;
  requested_by: string;
  reason: string;
}

/**
 * DTO for approving an approval.
 */
export interface ApproveDto {
  approved_by: string;
}

/**
 * DTO for rejecting an approval.
 */
export interface RejectDto {
  rejected_reason: string;
}

/**
 * DTO for superseding an approval.
 */
export interface SupersedeDto {
  superseded_by: string;
}

/**
 * Query parameters for listing approvals.
 */
export interface ListApprovalsQuery {
  status?: ApprovalStatus;
  object_type?: ApprovalObjectType;
}
