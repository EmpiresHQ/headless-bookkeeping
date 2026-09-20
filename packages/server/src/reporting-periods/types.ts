import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export type PeriodStatus = 'open' | 'locked';

/**
 * Which timeline a period belongs to (issue #207).
 *
 * - `vat`    — the tax calendar. A KMD is filed for it; filing freezes a VAT
 *              snapshot and locks it. This is what every period was before the
 *              annual scope existed, and what an unqualified period still is.
 * - `annual` — an independent FINANCIAL YEAR. The annual accounts are produced
 *              and closed against it. It carries no VAT declaration of its own.
 *
 * Both timelines cover the same dates; the non-overlap guard applies WITHIN a
 * timeline, so twelve monthly VAT periods and the financial year that spans
 * them coexist.
 */
export type PeriodKind = 'vat' | 'annual';

export const PERIOD_KINDS: readonly PeriodKind[] = ['vat', 'annual'];

export interface ReportingPeriod {
  id: number;
  name: string;
  start_date: string;
  end_date: string;
  kind: PeriodKind;
  status: PeriodStatus;
  filed_at: number | null;
  vat_report_snapshot_id: number | null;
  created_at: number;
}

export const createReportingPeriodSchema = z.object({
  name: z.string(),
  start_date: z.string(),
  end_date: z.string(),
  /**
   * Which timeline to create the period on. Omitted ⇒ `vat`, so every existing
   * caller keeps creating VAT periods exactly as before.
   */
  kind: z.enum(['vat', 'annual']).optional(),
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
