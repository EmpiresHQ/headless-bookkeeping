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
  netAmount: number; // EUR minor units, signed — the LEDGER's taxable-base legs
  vatAmount: number; // EUR minor units, signed — the VAT actually DEDUCTED
  /**
   * The DOCUMENT's own taxable value and VAT, when they differ from what the
   * ledger legs say (issue #211).
   *
   * They diverge on a purchase whose input VAT is not wholly deductible: the
   * non-deductible part is booked into the cost, so the ledger's base legs
   * carry `net + irrecoverable VAT` while `vatAmount` carries only what was
   * reclaimed. KMD INF part B is a report about the INVOICE, not about our cost
   * — its €1000 threshold is the invoice value WITHOUT VAT, and `invoiceSumVat`
   * is the invoice's own total — so it must read these rather than the cost.
   *
   * Absent ⇒ the ledger figures are the document's (every sales line, every
   * fully deductible purchase, and every payload frozen before #211, which
   * therefore keeps rendering exactly as it was filed).
   */
  documentNetAmount?: number;
  documentVatAmount?: number;
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
  /**
   * The jurisdiction says this warning makes a FINAL return unfilable — the
   * figures it describes are not ones the plugin is willing to put on a filed
   * document (issue #210). A DRAFT still renders, carrying the warning, so the
   * operator can see exactly what has to be fixed.
   */
  blocksFinal?: boolean;
}

export interface StatutoryReportResult {
  artifacts: StatutoryReportArtifact[];
  warnings: StatutoryWarning[];
}

/**
 * A frozen filing payload, as it was stored — possibly by an older version of
 * this code (issues #209, #210).
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
    row6_7_unresolved_acquisition?: number;
    unresolved_acquisition_vouchers?: string[];
  };
  const declaration: KmdDeclaration = { ...d } as KmdDeclaration;
  let changed = false;

  if (d.row3_1_intra_eu_supply === undefined) {
    declaration.row3_1_intra_eu_supply = d.vd_intra_eu_services ?? 0;
    changed = true;
  }
  // A payload frozen before #210 split the acquisition rows has no unresolved
  // bucket, because the code that froze it put every reverse-charge
  // acquisition in row 7. Reading it as zero reproduces that filing exactly —
  // and leaves the filed artifact renderable, which a blocking warning
  // computed from today's rules would not.
  if (d.row6_7_unresolved_acquisition === undefined) {
    declaration.row6_7_unresolved_acquisition = 0;
    changed = true;
  }
  if (d.unresolved_acquisition_vouchers === undefined) {
    declaration.unresolved_acquisition_vouchers = [];
    changed = true;
  }

  return changed ? { ...parsed, declaration } : parsed;
}
