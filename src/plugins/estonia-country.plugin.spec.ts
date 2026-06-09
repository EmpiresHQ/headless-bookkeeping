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
