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
}
