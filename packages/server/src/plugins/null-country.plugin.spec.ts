import { NullCountryPlugin } from './null-country.plugin';
import {
  CategoryDef,
  OrgContext,
  SupplierFacts,
} from './country-plugin.interface';

describe('NullCountryPlugin — retrieval + distribution tax', () => {
  const plugin = new NullCountryPlugin();
  const org: OrgContext = {
    country: 'IE',
    vatRegistered: true,
    baseCurrency: null,
  };
  const supplier: SupplierFacts = {
    country: 'IE',
    goodsVsServices: 'services',
    classificationMemory: [],
  };

  it('getVatRate maps IE codes to 0.23 and sentinel to 0', () => {
    expect(plugin.getVatRate('IE_INPUT_23')).toBe(0.23);
    expect(plugin.getVatRate('IE_OUTPUT_23')).toBe(0.23);
    expect(plugin.getVatRate('NULL_STANDARD')).toBe(0);
  });

  it('computeVat returns net/vat/gross at the code rate', () => {
    expect(plugin.computeVat(10000, 'IE_INPUT_23')).toEqual({
      netMinorUnits: 10000,
      vatMinorUnits: 2300,
      grossMinorUnits: 12300,
      rate: 0.23,
    });
  });

  it('previewExpenseTreatment composes mapping + domestic treatment, posts nothing', () => {
    const preview = plugin.previewExpenseTreatment('software', supplier, org);
    expect(preview.accountCode).toBe('EXPENSE_SOFTWARE');
    expect(preview.vatCode).toBe('IE_INPUT_23');
    expect(preview.rate).toBe(0.23);
    expect(preview.treatment).toBe('domestic');
  });

  it('getVatRegistrationThreshold is null for the neutral plugin', () => {
    expect(plugin.getVatRegistrationThreshold(org)).toBeNull();
  });

  it('resolveDistributionTax is null (no distribution tax in IE/Null)', () => {
    expect(plugin.resolveDistributionTax(10000, org)).toBeNull();
  });

  describe('getCategories()', () => {
    const plugin = new NullCountryPlugin();

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
      const facts = {
        country: 'IE',
        goodsVsServices: 'services' as const,
        classificationMemory: [],
      };
      const org = { country: 'IE', vatRegistered: true, baseCurrency: null };
      for (const cat of plugin.getCategories()) {
        expect(
          plugin.resolveCategoryMapping(cat.key, facts, org).accountCode,
        ).toBe(cat.accountCode);
      }
    });
  });

  it('generateAnnualAccounts returns empty artifacts and warnings', () => {
    const input = {
      period: { name: '2026', startDate: '2026-01-01', endDate: '2026-12-31' },
      priorPeriod: null,
      mode: 'draft' as const,
      balances: [],
      fixedAssets: [],
      periodNetIncome: 0,
      priorNetIncome: 0,
      retainedEarningsBroughtForward: 0,
      declarant: { regNumber: null, name: null },
    };
    const result = plugin.generateAnnualAccounts(input, {
      taxonomyVersion: 2026,
    });
    expect(result).toEqual({ artifacts: [], warnings: [] });
  });

  it('returns no statutory artifacts (jurisdiction has no filing format)', () => {
    const result = plugin.generateStatutoryReports(
      {
        declarant: { regNumber: null, name: null },
        period: {
          name: '2026-05',
          startDate: '2026-05-01',
          endDate: '2026-05-31',
        },
        mode: 'final',
        boxes: [],
        totals: { totalInputVat: 0, totalOutputVat: 0, totalPayable: 0 },
        salesLines: [],
        purchaseLines: [],
      },
      { formats: ['xml'] },
    );
    expect(result).toEqual({ artifacts: [], warnings: [] });
  });
});

describe('getAllowanceRates', () => {
  const plugin = new NullCountryPlugin();

  it('returns 7500 rate and 15-day high-rate window for foreign daily_allowance in 2025', () => {
    const rates = plugin.getAllowanceRates('daily_allowance', 2025, { domestic: false });
    expect(rates.ratePerUnit).toBe(7500);
    expect(rates.highRateDaysPerMonth).toBe(15);
    expect(rates.fallbackRatePerUnit).toBe(4000);
    expect(rates.monthlyTaxFreeCeiling).toBeNull();
  });

  it('returns 50 rate and 55000 monthly ceiling for mileage in 2025', () => {
    const rates = plugin.getAllowanceRates('mileage', 2025, { domestic: false });
    expect(rates.ratePerUnit).toBe(50);
    expect(rates.monthlyTaxFreeCeiling).toBe(55000);
  });

  it('returns null ceiling for phone (employer-defined)', () => {
    const rates = plugin.getAllowanceRates('phone', 2025, { domestic: false });
    expect(rates.monthlyTaxFreeCeiling).toBeNull();
    expect(rates.ratePerUnit).toBe(0);
  });
});

describe('getAllowanceAccount', () => {
  const plugin = new NullCountryPlugin();

  it('returns EXPENSE_TRAVEL for daily_allowance', () => {
    expect(plugin.getAllowanceAccount('daily_allowance')).toBe('EXPENSE_TRAVEL');
  });

  it('returns EXPENSE_TRAVEL for mileage', () => {
    expect(plugin.getAllowanceAccount('mileage')).toBe('EXPENSE_TRAVEL');
  });

  it('returns EXPENSE_OTHER for phone', () => {
    expect(plugin.getAllowanceAccount('phone')).toBe('EXPENSE_OTHER');
  });
});

describe('NullCountryPlugin — fixed assets', () => {
  const plugin = new NullCountryPlugin();
  const org = { country: 'IE', vatRegistered: true, baseCurrency: null };
  const supplier = {
    country: 'IE',
    goodsVsServices: 'goods' as const,
    classificationMemory: [],
  };

  it('maps fixed-asset categories to per-class accounts', () => {
    expect(
      plugin.resolveCategoryMapping('vehicle', supplier, org).accountCode,
    ).toBe('FIXED_ASSETS_VEHICLES');
    expect(
      plugin.resolveCategoryMapping('furniture', supplier, org).accountCode,
    ).toBe('FIXED_ASSETS_FURNITURE');
  });

  it('declares straight-line and zero residual everywhere (neutral stub)', () => {
    expect(plugin.getDepreciationMethod()).toBe('straight_line');
    expect(plugin.getFixedAssetDefaults('vehicle')).toEqual({
      defaultUsefulLifeYears: 5,
      defaultResidualMinor: 0,
    });
    expect(
      plugin.getFixedAssetDefaults('it_equipment').defaultUsefulLifeYears,
    ).toBe(3);
  });
});
