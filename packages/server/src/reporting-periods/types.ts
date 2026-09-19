import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export type PeriodStatus = 'open' | 'locked';

export interface ReportingPeriod {
  id: number;
  name: string;
  start_date: string;
  end_date: string;
  status: PeriodStatus;
  filed_at: number | null;
  vat_report_snapshot_id: number | null;
  created_at: number;
}

export const createReportingPeriodSchema = z.object({
  name: z.string(),
  start_date: z.string(),
  end_date: z.string(),
});

export class CreateReportingPeriodDto extends createZodDto(
  createReportingPeriodSchema,
) {}

export const createNextPeriodSchema = z.object({
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  name: z.string().optional(),
});

export class CreateNextPeriodDto extends createZodDto(createNextPeriodSchema) {}

export interface PeriodWarning {
  type: 'pending_approval' | 'unposted_draft';
  object_type: string;
  object_id: number;
  description: string;
}

/**
 * What one filing-state reconciliation did to a locked period (issue #200).
 * Append-only by construction: nothing is edited or deleted, so both the
 * previous and the current snapshot/payload versions stay addressable and
 * renderable.
 */
export interface FilingReconciliation {
  reporting_period_id: number;
  /** False ⇒ the period was already complete and current; nothing was written. */
  changed: boolean;
  /** True ⇒ a stale VAT snapshot was superseded by a fresh complete one. */
  snapshot_superseded: boolean;
  previous_snapshot_id: number | null;
  current_snapshot_id: number;
  /** The filing-payload version the filing state pinned before / after. */
  previous_payload_id: number | null;
  current_payload_id: number;
  /**
   * True ⇒ the period had already been reported to the tax authority, so the
   * corrected figures need a parandusdeklaratsioon. The system never files it.
   */
  correction_declaration_required: boolean;
  notes: string[];
}
