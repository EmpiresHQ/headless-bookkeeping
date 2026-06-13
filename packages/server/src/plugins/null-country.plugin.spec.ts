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
