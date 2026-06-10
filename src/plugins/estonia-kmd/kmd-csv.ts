// EMTA KMD CSV upload format renderer.
// Emits UTF-8 semicolon-separated rows in the official KMD CSV structure:
//   ONE KMD6 row, then zero-or-more A (sales INF) rows, then zero-or-more B (purchase INF) rows.
// Trailing empty columns on each row are trimmed; middle empty placeholders are kept.
// Jurisdiction-pure: no DB, no NestJS.
import { StatutoryReportInput } from '../statutory-report.types';
import { buildInfPart, InfRow } from './kmd-inf';
import { transactionsNetByRate } from './kmd-xml';

/** Minor units (cents) → euros with exactly 2 fraction digits. */
function eur(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * CSV-quote a field value if it contains a semicolon, double-quote, CR, or LF.
 * Wraps the value in double quotes and doubles any internal double-quote characters.
 */
function csvField(value: string): string {
  if (/[;\r\n"]/.test(value)) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

/** Trim trailing empty-string columns from a column array, then join with ';'. */
function buildRow(cols: string[]): string {
  let end = cols.length;
  while (end > 0 && cols[end - 1] === '') {
    end--;
  }
  return cols.slice(0, end).join(';');
}

/**
 * KMD6 row — main declaration body.
 * Column order (after identifier):
 *   noSales; noPurchases; sumPerPartnerSales; sumPerPartnerPurchases;
 *   transactions24; transactions22; transactions20; transactions9; transactions5; transactions13;
 *   transactionsZeroVat; euSupplyInclGoodsAndServicesZeroVat; euSupplyGoodsZeroVat; exportZeroVat;
 *   salePassengersWithReturnVat; inputVatTotal; importVat; fixedAssetsVat; carsVat; numberOfCars;
 *   carsPartialVat; numberOfCarsPartial; euAcquisitionsGoodsAndServicesTotal; euAcquisitionsGoods;
 *   acquisitionOtherGoodsAndServicesTotal; acquisitionImmovablesAndScrapMetalAndGold;
 *   supplyExemptFromTax; supplySpecialArrangements; adjustmentsPlus; adjustmentsMinus
 */
function renderKmd6Row(input: StatutoryReportInput, hasSales: boolean, hasPurchases: boolean): string {
  const netByRate = transactionsNetByRate(input);

  const t24 = netByRate.get(24) ?? 0;
  const t9 = netByRate.get(9) ?? 0;
  const t13 = netByRate.get(13) ?? 0;

  const inputVatTotal = input.totals.totalInputVat;

  const cols: string[] = [
    'KMD6',
    hasSales ? 'FALSE' : 'TRUE',       // noSales
    hasPurchases ? 'FALSE' : 'TRUE',    // noPurchases
    'FALSE',                            // sumPerPartnerSales
    'FALSE',                            // sumPerPartnerPurchases
    t24 !== 0 ? eur(t24) : '',          // transactions24
    '',                                 // transactions22
    '',                                 // transactions20
    t9 !== 0 ? eur(t9) : '',            // transactions9
    '',                                 // transactions5
    t13 !== 0 ? eur(t13) : '',          // transactions13
    '',                                 // transactionsZeroVat
    '',                                 // euSupplyInclGoodsAndServicesZeroVat
    '',                                 // euSupplyGoodsZeroVat
    '',                                 // exportZeroVat
    '',                                 // salePassengersWithReturnVat
    inputVatTotal !== 0 ? eur(inputVatTotal) : '', // inputVatTotal
    '',                                 // importVat
    '',                                 // fixedAssetsVat
    '',                                 // carsVat
    '',                                 // numberOfCars
    '',                                 // carsPartialVat
    '',                                 // numberOfCarsPartial
    '',                                 // euAcquisitionsGoodsAndServicesTotal
    '',                                 // euAcquisitionsGoods
    '',                                 // acquisitionOtherGoodsAndServicesTotal
    '',                                 // acquisitionImmovablesAndScrapMetalAndGold
    '',                                 // supplyExemptFromTax
    '',                                 // supplySpecialArrangements
    '',                                 // adjustmentsPlus
    '',                                 // adjustmentsMinus
  ];

  return buildRow(cols);
}

/**
 * A row (sales INF).
 * Columns: A; buyerRegCode; buyerName; invoiceNumber; invoiceDate; invoiceSum;
 *          taxRate; invoiceSumForRate; sumForRateInPeriod; comments
 */
function renderARow(row: InfRow): string {
  const cols: string[] = [
    'A',
    csvField(row.counterpartyRegNumber),
    csvField(row.counterpartyName),
    row.invoiceNumber ? csvField(row.invoiceNumber) : '',
    row.date ?? '',
    eur(row.netAmount),
    String(row.ratePercent),
    '',  // invoiceSumForRate — empty
    '',  // sumForRateInPeriod — empty
    '',  // comments — empty
  ];
  return buildRow(cols);
}

/**
 * B row (purchase INF).
 * Columns: B; sellerRegCode; sellerName; invoiceNumber; invoiceDate;
 *          invoiceSumVat; vatSum; vatInPeriod; comments
 */
function renderBRow(row: InfRow): string {
  const cols: string[] = [
    'B',
    csvField(row.counterpartyRegNumber),
    csvField(row.counterpartyName),
    row.invoiceNumber ? csvField(row.invoiceNumber) : '',
    row.date ?? '',
    eur(row.netAmount + row.vatAmount),
    '',  // vatSum — empty middle placeholder
    eur(row.vatAmount),
    '',  // comments — empty
  ];
  return buildRow(cols);
}

/** Render the official EMTA KMD CSV upload format. */
export function renderKmdCsv(input: StatutoryReportInput): string {
  const salesRows = buildInfPart(input.salesLines).rows;
  const purchaseRows = buildInfPart(input.purchaseLines).rows;

  const allRows: string[] = [];

  // ONE KMD6 row first
  allRows.push(renderKmd6Row(input, salesRows.length > 0, purchaseRows.length > 0));

  // A rows (sales INF)
  for (const row of salesRows) {
    allRows.push(renderARow(row));
  }

  // B rows (purchase INF)
  for (const row of purchaseRows) {
    allRows.push(renderBRow(row));
  }

  return allRows.join('\r\n');
}
