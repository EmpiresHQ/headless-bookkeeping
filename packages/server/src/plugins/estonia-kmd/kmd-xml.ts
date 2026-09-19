// EMTA KMD (VAT return) + KMD INF (Parts A/B) renderer.
// Emits a single <vatDeclaration> document valid against test/fixtures/vatdeclaration.xsd
// (root VatDeclaration, elementFormDefault=qualified, NO namespace, version KMD6).
//
// Jurisdiction-pure: no DB, no NestJS. This file is responsible ONLY for XML string
// construction; INF row eligibility (€1000 / B2B / standard-rate) is delegated to buildInfPart.
import { StatutoryReportInput } from '../statutory-report.types';
import { buildInfPart, InfRow } from './kmd-inf';

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

function renderSaleLine(row: InfRow): string {
  const parts: string[] = ['    <saleLine>'];
  parts.push(
    `      <buyerRegCode>${esc(row.counterpartyRegNumber)}</buyerRegCode>`,
  );
  parts.push(`      <buyerName>${esc(row.counterpartyName)}</buyerName>`);
  if (row.invoiceNumber) {
    parts.push(
      `      <invoiceNumber>${esc(row.invoiceNumber)}</invoiceNumber>`,
    );
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
  parts.push(
    `      <sellerRegCode>${esc(row.counterpartyRegNumber)}</sellerRegCode>`,
  );
  parts.push(`      <sellerName>${esc(row.counterpartyName)}</sellerName>`);
  if (row.invoiceNumber) {
    parts.push(
      `      <invoiceNumber>${esc(row.invoiceNumber)}</invoiceNumber>`,
    );
  }
  if (row.date) {
    parts.push(`      <invoiceDate>${esc(row.date)}</invoiceDate>`);
  }
  parts.push(
    `      <invoiceSumVat>${eur(row.netAmount + row.vatAmount)}</invoiceSumVat>`,
  );
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

  const d = input.declaration;

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<vatDeclaration>');
  lines.push(
    `  <taxPayerRegCode>${esc(input.declarant.regNumber ?? '')}</taxPayerRegCode>`,
  );
  lines.push(`  <year>${year}</year>`);
  lines.push(`  <month>${month}</month>`);
  lines.push('  <declarationType>1</declarationType>');
  lines.push('  <version>KMD6</version>');

  // declarationBody — required leading flags, then optional MonetaryValue boxes in schema order.
  lines.push('  <declarationBody>');
  lines.push(`    <noSales>${noSales ? 'true' : 'false'}</noSales>`);
  lines.push(
    `    <noPurchases>${noPurchases ? 'true' : 'false'}</noPurchases>`,
  );
  lines.push('    <sumPerPartnerSales>false</sumPerPartnerSales>');
  lines.push('    <sumPerPartnerPurchases>false</sumPerPartnerPurchases>');
  // Actual signed ledger bases, in XSD order. Rows 4 and 12/13 are
  // calculated by e-MTA and have no monetary element in the import schema.
  const boxes: [string, number][] = [
    ['transactions24', d.row1_base_24],
    ['transactions9', d.row2_base_9],
    ['transactions13', d.row2_base_13],
    ['transactionsZeroVat', d.row3_base_zero],
    ['euSupplyInclGoodsAndServicesZeroVat', d.vd_intra_eu_services],
    ['inputVatTotal', d.row5_input_vat],
    ['euAcquisitionsGoodsAndServicesTotal', d.row6_intra_eu_acquisition],
    ['acquisitionOtherGoodsAndServicesTotal', d.row7_other_acquisition],
  ];
  for (const [tag, amount] of boxes) {
    if (amount !== 0) lines.push(`    <${tag}>${eur(amount)}</${tag}>`);
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
