// EMTA KMD (VAT return) + KMD INF (Parts A/B) renderer.
// Emits a single <vatDeclaration> document valid against test/fixtures/vatdeclaration.xsd
// (root VatDeclaration, elementFormDefault=qualified, NO namespace, version KMD6).
//
// Jurisdiction-pure: no DB, no NestJS. This file is responsible ONLY for XML string
// construction; INF row eligibility (€1000 / B2B / standard-rate) is delegated to buildInfPart.
import { StatutoryReportInput } from '../statutory-report.types';
import { buildInfPart, EE_RATE_BY_CODE, InfRow } from './kmd-inf';

/** XML-escape the five predefined entities. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Minor units (cents) → euros with exactly 2 fraction digits (MonetaryValue). */
function eur(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Net taxable base per rate, derived from output VAT amounts on the boxes. */
export function transactionsNetByRate(input: StatutoryReportInput): Map<number, number> {
  const net = new Map<number, number>();
  for (const box of input.boxes) {
    const code = box.vat_code;
    if (!code || !code.startsWith('EE_OUTPUT_')) continue;
    const rate = EE_RATE_BY_CODE[code];
    if (rate === undefined) continue;
    const base = Math.round(box.output_vat / (rate / 100));
    net.set(rate, (net.get(rate) ?? 0) + base);
  }
  return net;
}

function renderSaleLine(row: InfRow): string {
  const parts: string[] = ['    <saleLine>'];
  parts.push(`      <buyerRegCode>${esc(row.counterpartyRegNumber)}</buyerRegCode>`);
  parts.push(`      <buyerName>${esc(row.counterpartyName)}</buyerName>`);
  if (row.invoiceNumber) {
    parts.push(`      <invoiceNumber>${esc(row.invoiceNumber)}</invoiceNumber>`);
  }
  if (row.date) {
    parts.push(`      <invoiceDate>${esc(row.date)}</invoiceDate>`);
  }
  parts.push(`      <invoiceSum>${eur(row.netAmount)}</invoiceSum>`);
  parts.push(`      <taxRate>${esc(String(row.ratePercent))}</taxRate>`);
  parts.push('    </saleLine>');
  return parts.join('\n');
}

function renderPurchaseLine(row: InfRow): string {
  const parts: string[] = ['    <purchaseLine>'];
  parts.push(`      <sellerRegCode>${esc(row.counterpartyRegNumber)}</sellerRegCode>`);
  parts.push(`      <sellerName>${esc(row.counterpartyName)}</sellerName>`);
  if (row.invoiceNumber) {
    parts.push(`      <invoiceNumber>${esc(row.invoiceNumber)}</invoiceNumber>`);
  }
  if (row.date) {
    parts.push(`      <invoiceDate>${esc(row.date)}</invoiceDate>`);
  }
  parts.push(`      <invoiceSumVat>${eur(row.netAmount + row.vatAmount)}</invoiceSumVat>`);
  parts.push(`      <vatInPeriod>${eur(row.vatAmount)}</vatInPeriod>`);
  parts.push('    </purchaseLine>');
  return parts.join('\n');
}

export function renderKmdXml(input: StatutoryReportInput): string {
  const salesRows = buildInfPart(input.salesLines).rows;
  const purchaseRows = buildInfPart(input.purchaseLines).rows;

  const year = input.period.startDate.slice(0, 4);
  const month = parseInt(input.period.startDate.slice(5, 7), 10);

  const noSales = salesRows.length === 0;
  const noPurchases = purchaseRows.length === 0;

  const netByRate = transactionsNetByRate(input);

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<vatDeclaration>');
  lines.push(`  <taxPayerRegCode>${esc(input.declarant.regNumber ?? '')}</taxPayerRegCode>`);
  lines.push(`  <year>${year}</year>`);
  lines.push(`  <month>${month}</month>`);
  lines.push('  <declarationType>1</declarationType>');
  lines.push('  <version>KMD6</version>');

  // declarationBody — required leading flags, then optional MonetaryValue boxes in schema order.
  lines.push('  <declarationBody>');
  lines.push(`    <noSales>${noSales ? 'true' : 'false'}</noSales>`);
  lines.push(`    <noPurchases>${noPurchases ? 'true' : 'false'}</noPurchases>`);
  lines.push('    <sumPerPartnerSales>false</sumPerPartnerSales>');
  lines.push('    <sumPerPartnerPurchases>false</sumPerPartnerPurchases>');
  // Schema order: transactions24, (22, 20, selfSupply20,) transactions9, (selfSupply9, 5,) transactions13.
  const t24 = netByRate.get(24) ?? 0;
  const t9 = netByRate.get(9) ?? 0;
  const t13 = netByRate.get(13) ?? 0;
  if (t24 !== 0) lines.push(`    <transactions24>${eur(t24)}</transactions24>`);
  if (t9 !== 0) lines.push(`    <transactions9>${eur(t9)}</transactions9>`);
  if (t13 !== 0) lines.push(`    <transactions13>${eur(t13)}</transactions13>`);
  // inputVatTotal sits after the transactions / zero-rate / export group in the schema.
  if (input.totals.totalInputVat !== 0) {
    lines.push(`    <inputVatTotal>${eur(input.totals.totalInputVat)}</inputVatTotal>`);
  }
  lines.push('  </declarationBody>');

  if (salesRows.length > 0) {
    lines.push('  <salesAnnex>');
    for (const row of salesRows) lines.push(renderSaleLine(row));
    lines.push('  </salesAnnex>');
  }

  if (purchaseRows.length > 0) {
    lines.push('  <purchasesAnnex>');
    for (const row of purchaseRows) lines.push(renderPurchaseLine(row));
    lines.push('  </purchasesAnnex>');
  }

  lines.push('</vatDeclaration>');
  return lines.join('\n');
}
