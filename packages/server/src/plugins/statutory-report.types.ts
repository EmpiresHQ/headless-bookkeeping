import type { KmdDeclaration, VatSummaryLine } from '../vat-report/types';

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
  /** Commercial registry code, not the VAT registration number. */
  declarant: { regNumber: string | null; name: string | null };
  period: { name: string; startDate: string; endDate: string };
  mode: 'final' | 'draft';
  boxes: VatSummaryLine[];
  declaration: KmdDeclaration;
  totals: {
    totalInputVat: number;
    totalOutputVat: number;
    totalPayable: number;
  };
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

/**
 * A frozen filing payload, as it was stored — possibly by an older version of
 * this code (issue #209).
 *
 * `statutory_filing_snapshot.payload` is IMMUTABLE: it is the artifact a filing
 * was made from, and it is never rewritten, not even to add a field. So a
 * payload frozen before KMD field 3.1 had its own declaration row carries a
 * declaration WITHOUT `row3_1_intra_eu_supply`, and rendering it must still
 * produce byte-identical output rather than `NaN`.
 *
 * Historically that box was rendered straight from `vd_intra_eu_services` —
 * the 0% intra-EU services total — so that is exactly what the missing field
 * meant, and reading it back that way reproduces the filed figures. (The two
 * diverge only for a supply the old code could not produce: an intra-EU supply
 * of GOODS, which reaches 3.1 but not the VD.)
 *
 * Applied on READ, to the parsed object only.
 */
export function normalizeFrozenStatutoryInput(
  parsed: StatutoryReportInput,
): StatutoryReportInput {
  const d = parsed.declaration as KmdDeclaration & {
    row3_1_intra_eu_supply?: number;
  };
  if (d.row3_1_intra_eu_supply !== undefined) return parsed;
  return {
    ...parsed,
    declaration: { ...d, row3_1_intra_eu_supply: d.vd_intra_eu_services ?? 0 },
  };
}
