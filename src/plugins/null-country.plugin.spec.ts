import { NullCountryPlugin } from './null-country.plugin';
import { OrgContext, SupplierFacts } from './country-plugin.interface';

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

  it('returns no statutory artifacts (jurisdiction has no filing format)', () => {
    const result = plugin.generateStatutoryReports(
      {
        declarant: { regNumber: null, name: null },
        period: { name: '2026-05', startDate: '2026-05-01', endDate: '2026-05-31' },
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
