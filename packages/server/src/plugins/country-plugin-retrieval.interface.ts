import {
  CrossBorderTreatment,
  OrgContext,
  SupplierFacts,
  VATCode,
} from './country-plugin.interface';

/** A VAT computation broken out for display — nothing is posted or registered. */
export interface VatComputation {
  netMinorUnits: number;
  vatMinorUnits: number;
  grossMinorUnits: number;
  rate: number;
}

/** A read-only preview of how an expense WOULD book — registers nothing. */
export interface ExpenseTreatmentPreview {
  accountCode: string;
  vatCode: VATCode;
  rate: number;
  treatment: CrossBorderTreatment;
}

/**
 * How a taxable-BASE line (revenue / expense, NOT a VAT-control line) maps onto
 * the jurisdiction's VAT-return rows. The VAT *amount* rows are derived by the
 * report from the control accounts (output VAT ← VAT_PAYABLE, input VAT ←
 * VAT_RECEIVABLE), so this only classifies where the taxable base belongs.
 *
 * All row numbers are jurisdiction form rows (for EE: the KMD käibedeklaratsioon).
 * A field is null when the base does not feed that kind of row.
 */
export interface KmdBaseClassification {
  /** Output käive row the base feeds (EE: 1 = 24%, 2 = 9%, 3 = 0%). */
  outputBaseRow: number | null;
  /**
   * Sub-row of {@link outputBaseRow} the base ALSO feeds, when the form breaks
   * the row down further (EE: '3.1' — the part of the 0% käive that is an
   * intra-Community supply to a taxable person of another member state). Null
   * when the row has no applicable breakdown: a third-country 0% supply sits in
   * row 3 and in no sub-row.
   */
  outputSubRow: string | null;
  /**
   * Acquisition base row for a reverse-charge PURCHASE (EE: 6 = goods/services
   * from another member state, 7 = other acquisition taxed by reverse charge,
   * e.g. an imported non-EU service).
   *
   * `'unresolved'` says the base IS a reverse-charge acquisition — so it is
   * read debit-positive and still carries its self-assessed VAT — but the
   * recorded facts do not decide WHICH acquisition row it belongs to (issue
   * #210). It is never silently folded into one of them: the report keeps it in
   * its own bucket, flags it for review, and the jurisdiction refuses to render
   * a FINAL return while it is nonzero.
   */
  acquisitionRow: number | 'unresolved' | null;
  /** Koondaruanne (VD / EC Sales List) tähis for an intra-EU supply, e.g. "3S". */
  vdCode: string | null;
  /** A note prompting accountant review (e.g. "verify row 6 vs 7"), or null. */
  review: string | null;
}

/**
 * What the ledger knows about a taxable-base line BEYOND its VAT code, where a
 * jurisdiction needs it to place the line (issue #210). Kernel-established
 * FACTS only — the row they imply stays the plugin's decision.
 */
export interface KmdClassificationContext {
  /**
   * This line reverses a voucher whose own period was already FILED under a
   * payload frozen before the acquisition origin was recorded. The removal
   * therefore comes back out of whichever row that filed return used, which the
   * jurisdiction knows and the kernel does not.
   */
  reversesVoucherFiledWithoutAcquisitionOrigin?: boolean;
}

/**
 * Compute-only, side-effect-free methods for the advisory ("consultant") agent.
 * Everything here READS/CALCULATES and registers NOTHING — no posting, no DB
 * writes. The advisory agent's tools type against THIS narrow surface so they
 * cannot reach the resolution/posting methods of the full CountryPlugin.
 */
export interface CountryPluginRetrieval {
  /**
   * Numeric VAT rate (0.0–1.0) for a plugin VAT code. 0 for zero/exempt/sentinel.
   *
   * `onDate` (YYYY-MM-DD, normally a tax-point date) asks for the rate that was
   * IN FORCE on that day rather than today's. A jurisdiction whose standard
   * rate has changed answers from its own effective-date history, so a
   * back-dated document is checked against the rate that actually governed it.
   * Omitting it keeps the current rate — every pre-existing caller is unchanged.
   */
  getVatRate(vatCode: VATCode, onDate?: string): number;

  /** Pure VAT arithmetic on a net amount (minor units) under a VAT code. */
  computeVat(netMinorUnits: number, vatCode: VATCode): VatComputation;

  /** Read-only "what would this expense book as" — composes category + cross-border. Posts nothing. */
  previewExpenseTreatment(
    category: string,
    supplierFacts: SupplierFacts,
    orgContext: OrgContext,
  ): ExpenseTreatmentPreview;

  /** Jurisdiction VAT registration threshold in base-currency minor units, or null if none. */
  getVatRegistrationThreshold(orgContext: OrgContext): number | null;

  /**
   * Classify a taxable-base line's VAT code onto this jurisdiction's VAT-return
   * rows (see {@link KmdBaseClassification}). Pure lookup; the VAT report uses it
   * to build the declaration. A code with no base-row meaning (e.g. a plain
   * domestic input code whose only return effect is the input-VAT total) returns
   * all-null. Plugins without a formal return (Null/IE here) classify nothing.
   *
   * `context` carries the ledger facts about THIS line that a code alone does
   * not (issue #210); a plugin that needs none of them ignores it.
   */
  classifyKmd(
    vatCode: VATCode,
    context?: KmdClassificationContext,
  ): KmdBaseClassification;
}
