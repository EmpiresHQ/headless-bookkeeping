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
   * Acquisition base row for a reverse-charge PURCHASE (EE: 6 = goods/services
   * from another member state, 7 = other acquisition taxed by reverse charge,
   * e.g. an imported non-EU service).
   */
  acquisitionRow: number | null;
  /** Koondaruanne (VD / EC Sales List) tähis for an intra-EU supply, e.g. "3S". */
  vdCode: string | null;
  /** A note prompting accountant review (e.g. "verify row 6 vs 7"), or null. */
  review: string | null;
}

/**
 * Compute-only, side-effect-free methods for the advisory ("consultant") agent.
 * Everything here READS/CALCULATES and registers NOTHING — no posting, no DB
 * writes. The advisory agent's tools type against THIS narrow surface so they
 * cannot reach the resolution/posting methods of the full CountryPlugin.
 */
export interface CountryPluginRetrieval {
  /** Numeric VAT rate (0.0–1.0) for a plugin VAT code. 0 for zero/exempt/sentinel. */
  getVatRate(vatCode: VATCode): number;

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
   */
  classifyKmd(vatCode: VATCode): KmdBaseClassification;
}
