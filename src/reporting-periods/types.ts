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

export interface CreateReportingPeriodDto {
  name: string;
  start_date: string;
  end_date: string;
}

export interface PeriodWarning {
  type: 'pending_approval' | 'unposted_draft';
  object_type: string;
  object_id: number;
  description: string;
}
