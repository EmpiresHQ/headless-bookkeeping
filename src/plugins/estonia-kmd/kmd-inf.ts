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
  netAmount: number;
  vatAmount: number;
}

export function buildInfPart(lines: StatutoryDocLine[]): {
  rows: InfRow[];
  warnings: StatutoryWarning[];
} {
  const warnings: StatutoryWarning[] = [];

  // 1. Keep only INF-reportable rates with a taxable (B2B) counterparty.
  const reportable = lines.filter(
    (l) => EE_RATE_BY_CODE[l.vatCode] !== undefined && l.counterpartyRegNumber,
  );

  // 2. Group by partner; the €1000 net threshold is per partner, signed net (use abs).
  const netByPartner = new Map<string, number>();
  for (const l of reportable) {
    const key = l.counterpartyRegNumber as string;
    netByPartner.set(key, (netByPartner.get(key) ?? 0) + Math.abs(l.netAmount));
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
      netAmount: l.netAmount,
      vatAmount: l.vatAmount,
    });
  }
  return { rows, warnings };
}
