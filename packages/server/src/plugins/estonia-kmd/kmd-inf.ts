import { StatutoryDocLine, StatutoryWarning } from '../statutory-report.types';

/** Rates that appear on INF; others (zero, reverse-charge) are excluded. */
export const EE_RATE_BY_CODE: Record<string, number> = {
  EE_OUTPUT_24: 24,
  EE_INPUT_24: 24,
  EE_OUTPUT_13: 13,
  EE_INPUT_13: 13,
  EE_OUTPUT_9: 9,
  EE_INPUT_9: 9,
};

const THRESHOLD_NET = 100000; // €1000 in cents

export interface InfRow {
  counterpartyRegNumber: string;
  counterpartyName: string;
  invoiceNumber: string | null;
  creditsInvoiceNumber: string | null;
  date: string;
  ratePercent: number;
  /** The DOCUMENT's taxable value — what the €1000 threshold measures. */
  netAmount: number;
  /** The DOCUMENT's own VAT — `netAmount + vatAmount` is `invoiceSumVat`. */
  vatAmount: number;
  /** The VAT actually DEDUCTED in this period (part B's `vatInPeriod`). */
  vatInPeriod: number;
}

/** The document's own figures, falling back to the ledger's (issue #211). */
const docNetOf = (l: StatutoryDocLine): number =>
  l.documentNetAmount ?? l.netAmount;
const docVatOf = (l: StatutoryDocLine): number =>
  l.documentVatAmount ?? l.vatAmount;

export function buildInfPart(
  lines: StatutoryDocLine[],
  side: 'sales' | 'purchase' = 'sales',
): {
  rows: InfRow[];
  warnings: StatutoryWarning[];
} {
  const warnings: StatutoryWarning[] = [];

  // 1. Keep only INF-reportable rates with a taxable (B2B) counterparty.
  //
  // On the PURCHASE side there is a second condition: part B reports invoices
  // whose input VAT was DEDUCTED. A standard-rated purchase on which nothing
  // was reclaimed — because we are not registered, hold a limited
  // registration, or have no deduction right for it — belongs to no part-B row
  // at all (EMTA KMD INF instructions, part B). Its VAT code still describes
  // the supply, and still faces the plugin's own validation; it simply does not
  // make the invoice reportable here (issue #211).
  //
  // The rule applies only to lines this code assembled, which is what the
  // presence of `documentNetAmount` marks. A payload frozen before #211 carries
  // neither document field, and is rendered exactly as it was filed — a filed
  // return is evidence, not something to re-judge by today's rules.
  const reportable = lines.filter(
    (l) =>
      EE_RATE_BY_CODE[l.vatCode] !== undefined &&
      l.counterpartyRegNumber &&
      (side === 'sales' ||
        l.documentNetAmount === undefined ||
        l.vatAmount !== 0),
  );

  // 2. Group by partner; the €1000 threshold is per partner and is measured on
  // the invoice value WITHOUT VAT — the DOCUMENT's net, not our cost. Booking
  // irrecoverable VAT into the cost must not push a partner over it.
  const netByPartner = new Map<string, number>();
  for (const l of reportable) {
    const key = l.counterpartyRegNumber as string;
    netByPartner.set(key, (netByPartner.get(key) ?? 0) + Math.abs(docNetOf(l)));
  }

  const rows: InfRow[] = [];
  for (const l of reportable) {
    const key = l.counterpartyRegNumber as string;
    if ((netByPartner.get(key) ?? 0) < THRESHOLD_NET) continue;
    if (!l.invoiceNumber) {
      warnings.push({
        code: 'inf_missing_invoice_number',
        message: `INF row for ${l.counterpartyName} has no invoice number`,
        counterparty: l.counterpartyName,
      });
    }
    rows.push({
      counterpartyRegNumber: key,
      counterpartyName: l.counterpartyName,
      invoiceNumber: l.invoiceNumber,
      creditsInvoiceNumber: l.creditsInvoiceNumber,
      date: l.date,
      ratePercent: EE_RATE_BY_CODE[l.vatCode],
      netAmount: docNetOf(l),
      vatAmount: docVatOf(l),
      vatInPeriod: l.vatAmount,
    });
  }
  return { rows, warnings };
}
