// src/plugins/estonia-country.plugin.spec.ts
import { EstoniaCountryPlugin } from './estonia-country.plugin';
import { OrgContext, SupplierFacts } from './country-plugin.interface';

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
  it('non-EU services (US) with foreign VAT charged → foreign_cost (no reclaim), vatCode null', () => {
    expect(
      ee.resolveCrossBorderTreatment(mk('US', 'services'), org, {
        vatCharged: true,
      }),
    ).toEqual({ treatment: 'foreign_cost', vatCode: null });
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
