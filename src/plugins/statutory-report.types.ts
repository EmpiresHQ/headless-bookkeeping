import type { VatSummaryLine } from '../vat-report/types';

export type StatutoryFormat = 'xml' | 'csv';

export interface StatutoryDocLine {
  documentKind: 'invoice' | 'credit_note';
  counterpartyName: string;
  counterpartyRegNumber: string | null; // null ⇒ non-taxable (B2C)
  invoiceNumber: string | null; // null ⇒ flagged by the plugin
  creditsInvoiceNumber: string | null; // set for credit notes
  date: string; // tax-point YYYY-MM-DD
  vatCode: string; // booked code, authoritative
  netAmount: number; // EUR minor units, signed
  vatAmount: number; // EUR minor units, signed
}

export interface StatutoryReportInput {
  declarant: { regNumber: string | null; name: string | null };
  period: { name: string; startDate: string; endDate: string };
  mode: 'final' | 'draft';
  boxes: VatSummaryLine[];
  totals: { totalInputVat: number; totalOutputVat: number; totalPayable: number };
  salesLines: StatutoryDocLine[];
  purchaseLines: StatutoryDocLine[];
}

export interface StatutoryReportArtifact {
  filename: string;
  mimeType: string;
  content: string;
}

export interface StatutoryWarning {
  code: string;
  message: string;
  counterparty?: string;
}

export interface StatutoryReportResult {
  artifacts: StatutoryReportArtifact[];
  warnings: StatutoryWarning[];
}
