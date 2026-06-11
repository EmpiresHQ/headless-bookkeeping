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
