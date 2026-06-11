// src/plugins/estonia-country.plugin.spec.ts
import { EstoniaCountryPlugin } from './estonia-country.plugin';
import {
  CategoryDef,
  OrgContext,
  SupplierFacts,
} from './country-plugin.interface';

describe('EstoniaCountryPlugin — VAT core', () => {
  const ee = new EstoniaCountryPlugin();
  const org: OrgContext = {
    country: 'EE',
    vatRegistered: true,
    baseCurrency: null,
  };
  const eeSupplier: SupplierFacts = {
    country: 'EE',
    goodsVsServices: 'services',
    classificationMemory: [],
  };

  it('name + base currency + monthly period', () => {
    expect(ee.getName()).toBe('EE');
    expect(ee.getDefaultBaseCurrency()).toBe('EUR');
    expect(ee.getPeriodFrequencyOptions()).toEqual(['monthly']);
    expect(ee.getDefaultPeriodFrequency()).toBe('monthly');
  });

  it('exposes the EE VAT code set', () => {
    const codes = ee.getVATCodes();
    expect(codes).toEqual(
      expect.arrayContaining([
        'EE_OUTPUT_24',
        'EE_INPUT_24',
        'EE_OUTPUT_13',
        'EE_INPUT_13',
        'EE_OUTPUT_9',
        'EE_INPUT_9',
        'EE_ZERO',
        'EE_REVERSE_CHARGE',
        'NULL_STANDARD',
      ]),
    );
  });

  it('maps revenue → EE_OUTPUT_24 and expenses → EE_INPUT_24 (standard auto-map)', () => {
    expect(ee.resolveCategoryMapping('revenue', eeSupplier, org)).toEqual({
      accountCode: 'REVENUE',
      vatCode: 'EE_OUTPUT_24',
    });
    expect(ee.resolveCategoryMapping('software', eeSupplier, org)).toEqual({
      accountCode: 'EXPENSE_SOFTWARE',
      vatCode: 'EE_INPUT_24',
    });
    expect(ee.resolveCategoryMapping('wibble', eeSupplier, org)).toEqual({
      accountCode: 'EXPENSE_OTHER',
      vatCode: 'EE_INPUT_24',
    });
  });

  it('maps revenue to an EU B2B customer of services → 0% intra-EU käive (Art 196)', () => {
    const dkCustomer: SupplierFacts = {
      country: 'DK',
      goodsVsServices: 'services',
      classificationMemory: [],
    };
    expect(ee.resolveCategoryMapping('revenue', dkCustomer, org)).toEqual({
      accountCode: 'REVENUE',
      vatCode: 'EE_OUTPUT_0_EU',
    });
  });

  it('keeps standard 24% revenue for a non-EU (export) customer — outside the intra-EU rule', () => {
    const usCustomer: SupplierFacts = {
      country: 'US',
      goodsVsServices: 'services',
      classificationMemory: [],
    };
    // Non-EU export of services is 0% too, but it is NOT the intra-EU (VD 3S)
    // case; we keep the standard code here so the report does not raise a VD
    // entry for it. (Refining export 0% is tracked separately.)
    expect(ee.resolveCategoryMapping('revenue', usCustomer, org).vatCode).toBe(
      'EE_OUTPUT_24',
    );
  });

  it('validateVATCode accepts the EE set + sentinel, rejects unknown', () => {
    expect(
      ee.validateVATCode('EE_INPUT_24', { supplier: eeSupplier, org }),
    ).toBe(true);
    expect(
      ee.validateVATCode('EE_REVERSE_CHARGE', { supplier: eeSupplier, org }),
    ).toBe(true);
    expect(
      ee.validateVATCode('NULL_STANDARD', { supplier: eeSupplier, org }),
    ).toBe(true);
    expect(
      ee.validateVATCode('DK_INPUT_25', { supplier: eeSupplier, org }),
    ).toBe(false);
  });

  it('rounds to whole cents and resolves personal disposition by org type', () => {
    expect(ee.roundToBaseMinorUnits(100.4)).toBe(100);
    expect(ee.resolvePersonalDispositionAccount('company')).toBe(
      'SHAREHOLDER_LOAN',
    );
    expect(ee.resolvePersonalDispositionAccount('sole_proprietor')).toBe(
      'OWNERS_DRAWINGS',
    );
  });
});

describe('EstoniaCountryPlugin — cross-border', () => {
  const ee = new EstoniaCountryPlugin();
  const org: OrgContext = {
    country: 'EE',
    vatRegistered: true,
    baseCurrency: null,
  };
  const mk = (
    country: string,
    gvs: 'goods' | 'services' | 'unknown',
  ): SupplierFacts => ({
    country,
    goodsVsServices: gvs,
    classificationMemory: [],
  });

  it('EE supplier → domestic, EE_INPUT_24', () => {
    expect(
      ee.resolveCrossBorderTreatment(mk('EE', 'services'), org, {
        vatCharged: true,
      }),
    ).toEqual({ treatment: 'domestic', vatCode: 'EE_INPUT_24' });
  });
  it('EU supplier (DE) → reverse_charge, EE_REVERSE_CHARGE (our code)', () => {
    expect(
      ee.resolveCrossBorderTreatment(mk('DE', 'services'), org, {
        vatCharged: false,
      }),
    ).toEqual({ treatment: 'reverse_charge', vatCode: 'EE_REVERSE_CHARGE' });
  });
  it('non-EU goods (US) → import', () => {
    expect(
      ee.resolveCrossBorderTreatment(mk('US', 'goods'), org, {
        vatCharged: false,
      }).treatment,
    ).toBe('import');
  });
  // Imported B2B services: place of supply is Estonia (KMS §10), so the buyer
  // self-assesses regardless of whether the supplier sits inside or outside the
  // EU. Non-EU service imports are reverse_charge just like intra-EU ones.
  it('non-EU services (US, no VAT) → reverse_charge, EE_REVERSE_CHARGE', () => {
    expect(
      ee.resolveCrossBorderTreatment(mk('US', 'services'), org, {
        vatCharged: false,
      }),
    ).toEqual({ treatment: 'reverse_charge', vatCode: 'EE_REVERSE_CHARGE' });
  });
  it('non-EU services (US) with foreign tax charged → still reverse_charge (foreign tax is not reclaimable EE VAT)', () => {
    expect(
      ee.resolveCrossBorderTreatment(mk('US', 'services'), org, {
        vatCharged: true,
      }),
    ).toEqual({ treatment: 'reverse_charge', vatCode: 'EE_REVERSE_CHARGE' });
  });
});

describe('EstoniaCountryPlugin — FX', () => {
  const ee = new EstoniaCountryPlugin();
  it('same currency → 1.0', () => {
    expect(ee.getReferenceRate('EUR', 'EUR', '2026-06-09')).toBe(1.0);
  });
  it('returns deterministic EUR-cross rates (and inverse)', () => {
    expect(ee.getReferenceRate('USD', 'EUR', '2026-06-09')).toBeCloseTo(
      0.92,
      2,
    );
    expect(ee.getReferenceRate('EUR', 'USD', '2026-06-09')).toBeCloseTo(
      1.0 / 0.92,
      2,
    );
  });
  it('throws on an unknown currency pair (honest, never silent 1.0)', () => {
    expect(() => ee.getReferenceRate('JPY', 'EUR', '2026-06-09')).toThrow(
      /rate/i,
    );
  });
});

describe('EstoniaCountryPlugin — retrieval + distribution tax', () => {
  const ee = new EstoniaCountryPlugin();
  const org: OrgContext = {
    country: 'EE',
    vatRegistered: true,
    baseCurrency: null,
  };
  const eeSup: SupplierFacts = {
    country: 'EE',
    goodsVsServices: 'services',
    classificationMemory: [],
  };

  it('getVatRate / computeVat at 24%', () => {
    expect(ee.getVatRate('EE_INPUT_24')).toBe(0.24);
    expect(ee.computeVat(100000, 'EE_INPUT_24')).toEqual({
      netMinorUnits: 100000,
      vatMinorUnits: 24000,
      grossMinorUnits: 124000,
      rate: 0.24,
    });
  });
  it('previewExpenseTreatment for a domestic software expense', () => {
    expect(ee.previewExpenseTreatment('software', eeSup, org)).toEqual({
      accountCode: 'EXPENSE_SOFTWARE',
      vatCode: 'EE_INPUT_24',
      rate: 0.24,
      treatment: 'domestic',
    });
  });
  it('getVatRegistrationThreshold = €40,000 in cents', () => {
    expect(ee.getVatRegistrationThreshold(org)).toBe(4000000);
  });
  it('dividendWithholdingRate is 0 (EE has no withholding)', () => {
    expect(ee.dividendWithholdingRate(org)).toBe(0.0);
  });
  it('resolveDistributionTax: 22/78 of net, to DISTRIBUTION_TAX_PAYABLE', () => {
    // net €1000.00 → tax = round(100000 * 22/78) = 28205
    expect(ee.resolveDistributionTax(100000, org)).toEqual({
      accountCode: 'DISTRIBUTION_TAX_PAYABLE',
      amount: 28205,
    });
  });
  it('assertDistributable blocks when net + distribution tax exceeds distributable', () => {
    // net 100000 + tax 28205 = 128205 total equity hit
    expect(ee.assertDistributable(100000, 128205, org)).toBe(true);
    expect(ee.assertDistributable(100000, 128204, org)).toBe(false);
  });
});

describe('generateStatutoryReports', () => {
  const plugin = new EstoniaCountryPlugin();
  const input = {
    declarant: { regNumber: 'EE100000001', name: 'Test OÜ' },
    period: { name: '2026-05', startDate: '2026-05-01', endDate: '2026-05-31' },
    mode: 'final' as const,
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
        documentKind: 'invoice' as const,
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

  it('returns xml + csv artifacts when both formats requested', () => {
    const { artifacts } = plugin.generateStatutoryReports(input, {
      formats: ['xml', 'csv'],
    });
    expect(artifacts.map((a) => a.mimeType).sort()).toEqual([
      'application/xml',
      'text/csv',
    ]);
    expect(artifacts.find((a) => a.filename.endsWith('.xml'))).toBeDefined();
    expect(artifacts.find((a) => a.filename.endsWith('.csv'))).toBeDefined();
  });

  it('returns only the requested format', () => {
    const { artifacts } = plugin.generateStatutoryReports(input, {
      formats: ['xml'],
    });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].mimeType).toBe('application/xml');
  });

  it('warns when the declarant reg number is missing', () => {
    const bad = { ...input, declarant: { regNumber: null, name: 'X' } };
    const { warnings } = plugin.generateStatutoryReports(bad, {
      formats: ['xml'],
    });
    expect(
      warnings.some((w) => w.code === 'missing_declarant_reg_number'),
    ).toBe(true);
  });

  it('warns when the declarant reg number format is invalid (not EE + 9 digits)', () => {
    const bad = { ...input, declarant: { regNumber: 'XX1', name: 'X' } };
    const { warnings } = plugin.generateStatutoryReports(bad, {
      formats: ['xml'],
    });
    expect(
      warnings.some((w) => w.code === 'invalid_declarant_reg_number'),
    ).toBe(true);
  });

  it('surfaces INF missing-invoice-number warnings from buildInfPart', () => {
    const noInv = {
      ...input,
      salesLines: [
        { ...input.salesLines[0], invoiceNumber: null, netAmount: 500000 },
      ],
    };
    const { warnings } = plugin.generateStatutoryReports(noInv, {
      formats: ['xml'],
    });
    expect(warnings.some((w) => w.code === 'inf_missing_invoice_number')).toBe(
      true,
    );
  });
});

describe('EstoniaCountryPlugin — KMD row classification', () => {
  const ee = new EstoniaCountryPlugin();

  it('standard 24% output → row 1', () => {
    expect(ee.classifyKmd('EE_OUTPUT_24')).toEqual({
      outputBaseRow: 1,
      acquisitionRow: null,
      vdCode: null,
      review: null,
    });
  });

  it('9% output → row 2', () => {
    expect(ee.classifyKmd('EE_OUTPUT_9').outputBaseRow).toBe(2);
  });

  it('0% intra-EU service → row 3 + VD tähis 3S', () => {
    expect(ee.classifyKmd('EE_OUTPUT_0_EU')).toEqual({
      outputBaseRow: 3,
      acquisitionRow: null,
      vdCode: '3S',
      review: null,
    });
  });

  it('plain 0% (export/other) → row 3, no VD', () => {
    expect(ee.classifyKmd('EE_ZERO')).toEqual({
      outputBaseRow: 3,
      acquisitionRow: null,
      vdCode: null,
      review: null,
    });
  });

  it('reverse charge → self-assessed supply (row 1) + acquisition (row 7), flagged for 6-vs-7 review', () => {
    const c = ee.classifyKmd('EE_REVERSE_CHARGE');
    expect(c.outputBaseRow).toBe(1);
    expect(c.acquisitionRow).toBe(7);
    expect(c.review).toMatch(/row 6.*7|intra-EU/i);
  });

  it('domestic input 24% feeds only the input-VAT total (no base row)', () => {
    expect(ee.classifyKmd('EE_INPUT_24')).toEqual({
      outputBaseRow: null,
      acquisitionRow: null,
      vdCode: null,
      review: null,
    });
  });
});

describe('EstoniaCountryPlugin — getCategories()', () => {
  const plugin = new EstoniaCountryPlugin();
  const org: OrgContext = {
    country: 'EE',
    vatRegistered: true,
    baseCurrency: null,
  };
  const eeSupplier: SupplierFacts = {
    country: 'EE',
    goodsVsServices: 'services',
    classificationMemory: [],
  };

  it('returns the expense categories with stable key/label/accountCode', () => {
    const cats = plugin.getCategories();
    const keys = cats.map((c) => c.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'software',
        'transport',
        'travel',
        'marketing',
        'salary',
        'contractor',
        'rent',
        'tax',
        'bank fee',
        'meals',
        'insurance',
        'education',
      ]),
    );
    // No 'revenue' — getCategories() is the EXPENSE set only.
    expect(keys).not.toContain('revenue');
    const software: CategoryDef | undefined = cats.find(
      (c) => c.key === 'software',
    );
    expect(software).toEqual({
      key: 'software',
      label: expect.any(String) as unknown,
      accountCode: 'EXPENSE_SOFTWARE',
    });
  });

  it('is consistent with resolveCategoryMapping (no divergence possible)', () => {
    for (const cat of plugin.getCategories()) {
      expect(
        plugin.resolveCategoryMapping(cat.key, eeSupplier, org).accountCode,
      ).toBe(cat.accountCode);
    }
  });
});
