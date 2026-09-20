import { emptyKmdDeclaration } from '../../../test/kmd-fixture';
import { renderKmdXml } from './kmd-xml';
import { validateAgainstKmdXsd } from './xsd-validate';
import { readFileSync } from 'fs';
import { join } from 'path';
import { StatutoryReportInput } from '../statutory-report.types';

const xsd = readFileSync(
  join(__dirname, '../../../test/fixtures/vatdeclaration.xsd'),
  'utf8',
);

const input: StatutoryReportInput = {
  declarant: { regNumber: '17499653', name: 'Test OÜ' },
  period: { name: '2026-05', startDate: '2026-05-01', endDate: '2026-05-31' },
  mode: 'final',
  declaration: {
    ...emptyKmdDeclaration,
    row1_base_24: 200000,
    row4_output_vat: 48000,
    net_vat_due: 48000,
  },
  boxes: [
    {
      vat_code: 'EE_OUTPUT_24',
      input_vat: 0,
      output_vat: 48000,
      line_count: 1,
    },
  ],
  totals: { totalInputVat: 0, totalOutputVat: 48000, totalPayable: 48000 },
  salesLines: [
    {
      documentKind: 'invoice',
      counterpartyName: 'Acme OÜ',
      counterpartyRegNumber: 'EE100000002',
      invoiceNumber: 'INV-1',
      creditsInvoiceNumber: null,
      date: '2026-05-10',
      vatCode: 'EE_OUTPUT_24',
      netAmount: 200000,
      vatAmount: 48000,
    },
  ],
  purchaseLines: [],
};

it('produces XSD-valid KMD XML with declarant + period', () => {
  const xml = renderKmdXml(input);
  const res = validateAgainstKmdXsd(xml, xsd);
  expect(res.errors).toEqual([]);
  expect(res.valid).toBe(true);
  expect(xml).toContain('<taxPayerRegCode>17499653</taxPayerRegCode>');
});

it('includes the INF Part A row for a ≥€1000 partner', () => {
  const xml = renderKmdXml(input);
  expect(xml).toContain('<invoiceNumber>INV-1</invoiceNumber>');
  expect(xml).toContain('EE100000002');
  expect(xml).toContain('<invoiceSum>2000.00</invoiceSum>');
  expect(xml).toContain('<taxRate>24</taxRate>');
});

it('stays XSD-valid with a purchase line and a credit note (negative)', () => {
  const withB = {
    ...input,
    purchaseLines: [
      {
        documentKind: 'invoice' as const,
        counterpartyName: 'Vend OÜ',
        counterpartyRegNumber: 'EE100000003',
        invoiceNumber: 'SUP-1',
        creditsInvoiceNumber: null,
        date: '2026-05-12',
        vatCode: 'EE_INPUT_24',
        netAmount: 500000,
        vatAmount: 120000,
      },
      {
        documentKind: 'credit_note' as const,
        counterpartyName: 'Vend OÜ',
        counterpartyRegNumber: 'EE100000003',
        invoiceNumber: 'CN-1',
        creditsInvoiceNumber: 'SUP-1',
        date: '2026-05-20',
        vatCode: 'EE_INPUT_24',
        netAmount: -100000,
        vatAmount: -24000,
      },
    ],
  };
  const res = validateAgainstKmdXsd(renderKmdXml(withB), xsd);
  expect(res.errors).toEqual([]);
});

it('exports all supported non-zero declaration fields in schema order without deriving bases from VAT', () => {
  const xml = renderKmdXml({
    ...input,
    declaration: {
      ...emptyKmdDeclaration,
      row1_base_24: 20612,
      row2_base_reduced: 30003,
      row2_base_9: 10001,
      row2_base_13: 20002,
      row3_base_zero: 810000,
      // KMD field 3.1 is rendered from its own declaration row (issue #209);
      // the VD total is a different report and no longer feeds the XML box.
      row3_1_intra_eu_supply: 800000,
      vd_intra_eu_services: 800000,
      row4_output_vat: 8447,
      row5_input_vat: 4947,
      row6_intra_eu_acquisition: 12345,
      row7_other_acquisition: 20612,
    },
  });
  for (const [tag, amount] of [
    ['transactions24', '206.12'],
    ['transactions9', '100.01'],
    ['transactions13', '200.02'],
    ['transactionsZeroVat', '8100.00'],
    ['euSupplyInclGoodsAndServicesZeroVat', '8000.00'],
    ['inputVatTotal', '49.47'],
    ['euAcquisitionsGoodsAndServicesTotal', '123.45'],
    ['acquisitionOtherGoodsAndServicesTotal', '206.12'],
  ]) {
    expect(xml).toContain('<' + tag + '>' + amount + '</' + tag + '>');
  }
  expect(validateAgainstKmdXsd(xml, xsd)).toEqual({ valid: true, errors: [] });
});

it('preserves negative declaration bases for credit notes', () => {
  const xml = renderKmdXml({
    ...input,
    declaration: { ...emptyKmdDeclaration, row1_base_24: -10001 },
  });
  expect(xml).toContain('<transactions24>-100.01</transactions24>');
  expect(validateAgainstKmdXsd(xml, xsd)).toEqual({ valid: true, errors: [] });
});
