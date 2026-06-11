import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Approval status enum — matches the CHECK constraint in the approval table.
 *
 * States: pending → approved | rejected | superseded
 * Never auto-resolves (ADR-0012).
 */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'superseded';

/**
 * Object types that can be held for approval. `reconciliation_match` is staged
 * by the reconciliation engine (draft match) and is NOT a voucher-generating
 * business object — approving it activates the sub-ledger link (and posts the
 * realized-FX voucher for a multi-currency settlement).
 */
export type ApprovalObjectType =
  | 'expense'
  | 'sales_invoice'
  | 'reconciliation_match';

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
  policy_reason: string | null;
  superseded_by: number | null;
  created_at: number;
  resolved_at: number | null;
}

/**
 * DTO for creating a new approval.
 */
export const createApprovalSchema = z.object({
  object_type: z.enum(['expense', 'sales_invoice', 'reconciliation_match']),
  object_id: z.number().int(),
  requested_by: z.string(),
  reason: z.string(),
});

export class CreateApprovalDto extends createZodDto(createApprovalSchema) {}

/**
 * DTO for approving an approval.
 */
export const approveSchema = z.object({
  approved_by: z.string(),
});

export class ApproveDto extends createZodDto(approveSchema) {}

/**
 * DTO for rejecting an approval.
 */
export const rejectSchema = z.object({
  rejected_reason: z.string(),
});

export class RejectDto extends createZodDto(rejectSchema) {}

/**
 * DTO for superseding an approval.
 */
export const supersedeSchema = z.object({
  superseded_by: z.string(),
});

export class SupersedeDto extends createZodDto(supersedeSchema) {}

/**
 * Query parameters for listing approvals.
 */
export interface ListApprovalsQuery {
  status?: ApprovalStatus;
  object_type?: ApprovalObjectType;
}
