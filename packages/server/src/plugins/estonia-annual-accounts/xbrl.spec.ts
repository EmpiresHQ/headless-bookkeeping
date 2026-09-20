import { minorToEuros, renderAnnualAccountsXbrl } from './xbrl';
import type { AnnualAccountsInput } from '../annual-accounts.types';
import { AnnualAccountsRenderError } from '../annual-accounts.types';
import { validateEtGaapInstance } from '../../../test/xbrl/validate-xbrl-instance';
import { etGaapConcepts } from '../../../test/xbrl/et-gaap-taxonomy';
import { RTJ_LINES } from './rtj-mapping';

function baseInput(
  over: Partial<AnnualAccountsInput> = {},
): AnnualAccountsInput {
  return {
    period: { name: '2026', startDate: '2026-01-01', endDate: '2026-12-31' },
    priorPeriod: {
      name: '2025',
      startDate: '2025-01-01',
      endDate: '2025-12-31',
    },
    mode: 'draft',
    balances: [
      { code: 'BANK_EUR', type: 'asset', current: 30000, prior: 10000 },
      { code: 'AR', type: 'asset', current: 5000, prior: 2000 },
      {
        code: 'FIXED_ASSETS_VEHICLES',
        type: 'asset',
        current: 20000,
        prior: 20000,
      },
      {
        code: 'ACCUM_DEPRECIATION_VEHICLES',
        type: 'asset',
        current: -4000,
        prior: -2000,
      },
      { code: 'AP', type: 'liability', current: 8000, prior: 3000 },
      { code: 'EQUITY', type: 'equity', current: 2500, prior: 2500 },
      {
        code: 'RETAINED_EARNINGS',
        type: 'equity',
        current: 24500,
        prior: 24500,
      },
      { code: 'REVENUE', type: 'revenue', current: 60000, prior: 30000 },
      { code: 'EXPENSE_OTHER', type: 'expense', current: 42000, prior: 6000 },
      {
        code: 'DEPRECIATION_EXPENSE',
        type: 'expense',
        current: 2000,
        prior: 2000,
      },
    ],
    fixedAssets: [
      { id: 1, assetClass: 'vehicle', costMinor: 20000, retired: false },
    ],
    // Self-consistent: assets 51000 = payables 8000 + capital 2500 + retainedBF
    // 24500 + periodNetIncome 16000; and periodNetIncome 16000 = revenue 60000 −
    // otherOp 42000 − depreciation 2000. RETAINED_EARNINGS.current (24500) is
    // brought-forward only (no year-end sweep, ADR §3); the period result is the
    // separate live AnnualPeriodProfitLoss line.
    periodNetIncome: 16000,
    priorNetIncome: 22000,
    retainedEarningsBroughtForward: 24500,
    declarant: { regNumber: '17499653', name: 'Test OÜ' },
    ...over,
  };
}

const render = (over: Partial<AnnualAccountsInput> = {}): string =>
  renderAnnualAccountsXbrl(baseInput(over), { taxonomyVersion: 2026 });

describe('minorToEuros', () => {
  it('reports minor units as currency units, not as cents', () => {
    // Issue #204: 120000 minor units is EUR 1,200.00, not 120000.
    expect(minorToEuros(120000)).toBe('1200.00');
  });

  it('keeps sub-euro, zero and negative amounts exact', () => {
    expect(minorToEuros(1)).toBe('0.01');
    expect(minorToEuros(99)).toBe('0.99');
    expect(minorToEuros(0)).toBe('0.00');
    expect(minorToEuros(-1)).toBe('-0.01');
    expect(minorToEuros(-120099)).toBe('-1200.99');
  });

  it('refuses a fractional minor amount instead of rounding it away', () => {
    expect(() => minorToEuros(100.5)).toThrow(AnnualAccountsRenderError);
    expect(() => minorToEuros(Number.NaN)).toThrow(AnnualAccountsRenderError);
  });
});

describe('renderAnnualAccountsXbrl', () => {
  it('validates against the official et-gaap_2026-01-01 taxonomy', () => {
    const result = validateEtGaapInstance(render());
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('binds the instance to the pinned taxonomy', () => {
    const xbrl = render();
    expect(xbrl).toContain(
      'xmlns:et-gaap="http://xbrl.eesti.ee/taxonomy/et-gaap_2026-01-01/"',
    );
    expect(xbrl).toContain(
      '<link:schemaRef xlink:type="simple" xlink:href="http://xbrl.eesti.ee/taxonomy/et-gaap_2026-01-01/et-gaap-cor_2026-01-01.xsd"/>',
    );
    expect(xbrl).toContain(
      '<xbrli:unit id="EUR"><xbrli:measure>iso4217:EUR</xbrli:measure></xbrli:unit>',
    );
  });

  it('reports EUR 1,200.00 for 120000 minor units, at the accuracy it claims', () => {
    // The issue's own reproduction: Dr FIXED_ASSETS_IT / Cr EQUITY 120000
    // minor units, no register row so no virtual depreciation.
    const xbrl = render({
      balances: [
        { code: 'FIXED_ASSETS_IT', type: 'asset', current: 120000, prior: 0 },
        { code: 'EQUITY', type: 'equity', current: 120000, prior: 0 },
      ],
      fixedAssets: [],
      priorPeriod: null,
      periodNetIncome: 0,
      priorNetIncome: 0,
      retainedEarningsBroughtForward: 0,
    });
    expect(xbrl).toContain(
      '<et-gaap:PropertyPlantAndEquipment contextRef="i-2026-12-31" unitRef="EUR" decimals="2">1200.00</et-gaap:PropertyPlantAndEquipment>',
    );
    expect(xbrl).not.toContain('decimals="-2"');
    expect(validateEtGaapInstance(xbrl).errors).toEqual([]);
  });

  it('uses an instant context for the balance sheet and a duration for the income statement', () => {
    const xbrl = render();
    expect(xbrl).toContain(
      '<xbrli:period><xbrli:instant>2026-12-31</xbrli:instant></xbrli:period>',
    );
    expect(xbrl).toContain(
      '<xbrli:period><xbrli:startDate>2026-01-01</xbrli:startDate><xbrli:endDate>2026-12-31</xbrli:endDate></xbrli:period>',
    );
    expect(xbrl).toContain(
      '<et-gaap:CashAndCashEquivalents contextRef="i-2026-12-31" unitRef="EUR" decimals="2">300.00</et-gaap:CashAndCashEquivalents>',
    );
    expect(xbrl).toContain(
      '<et-gaap:Revenue contextRef="d-2026-01-01_2026-12-31" unitRef="EUR" decimals="2">600.00</et-gaap:Revenue>',
    );
    // No bare endDate-only period survives anywhere.
    expect(xbrl).not.toMatch(
      /<xbrli:period><xbrli:endDate>[^<]*<\/xbrli:endDate><\/xbrli:period>/,
    );
  });

  it('derives prior-period contexts from the actual prior period, never a hardcoded year', () => {
    const xbrl = render({
      period: { name: 'FY24', startDate: '2024-01-01', endDate: '2024-12-31' },
      priorPeriod: {
        name: 'FY23',
        startDate: '2023-01-01',
        endDate: '2023-12-31',
      },
    });
    expect(xbrl).toContain('<xbrli:context id="i-2023-12-31">');
    expect(xbrl).toContain('<xbrli:context id="d-2023-01-01_2023-12-31">');
    expect(xbrl).not.toContain('2025-12-31');
    expect(validateEtGaapInstance(xbrl).errors).toEqual([]);
  });

  it('reports a short financial year on its own dates', () => {
    const xbrl = render({
      period: { name: 'stub', startDate: '2026-04-01', endDate: '2026-12-31' },
      priorPeriod: null,
    });
    expect(xbrl).toContain('<xbrli:context id="d-2026-04-01_2026-12-31">');
    expect(validateEtGaapInstance(xbrl).errors).toEqual([]);
  });

  it('reports expenses with the sign the taxonomy calculation expects', () => {
    const xbrl = render();
    // et-gaap expense concepts are xbrli:balance="credit" and sum into
    // TotalProfitLoss with weight +1, so a 42000-minor expense reports as
    // −420.00 and the signed sum is the period result.
    expect(xbrl).toContain(
      '<et-gaap:OtherOperatingExpense contextRef="d-2026-01-01_2026-12-31" unitRef="EUR" decimals="2">-420.00</et-gaap:OtherOperatingExpense>',
    );
    expect(xbrl).toContain(
      '<et-gaap:DepreciationAndImpairmentLossReversal contextRef="d-2026-01-01_2026-12-31" unitRef="EUR" decimals="2">-20.00</et-gaap:DepreciationAndImpairmentLossReversal>',
    );
    expect(xbrl).toContain(
      '<et-gaap:TotalProfitLoss contextRef="d-2026-01-01_2026-12-31" unitRef="EUR" decimals="2">160.00</et-gaap:TotalProfitLoss>',
    );
    // Revenue 600.00 − 420.00 − 20.00 = 160.00, the reported total.
    expect(600 - 420 - 20).toBe(160);
  });

  it('carries the taxonomy subtotals: Assets = Liabilities + Equity', () => {
    const xbrl = render();
    expect(xbrl).toContain(
      '<et-gaap:CurrentAssets contextRef="i-2026-12-31" unitRef="EUR" decimals="2">350.00</et-gaap:CurrentAssets>',
    );
    expect(xbrl).toContain(
      '<et-gaap:NonCurrentAssets contextRef="i-2026-12-31" unitRef="EUR" decimals="2">160.00</et-gaap:NonCurrentAssets>',
    );
    expect(xbrl).toContain(
      '<et-gaap:Assets contextRef="i-2026-12-31" unitRef="EUR" decimals="2">510.00</et-gaap:Assets>',
    );
    expect(xbrl).toContain(
      '<et-gaap:Equity contextRef="i-2026-12-31" unitRef="EUR" decimals="2">430.00</et-gaap:Equity>',
    );
    expect(xbrl).toContain(
      '<et-gaap:LiabilitiesAndEquity contextRef="i-2026-12-31" unitRef="EUR" decimals="2">510.00</et-gaap:LiabilitiesAndEquity>',
    );
  });

  it('uses the registry code as the declarant identity, and reports it as a fact', () => {
    const xbrl = render();
    expect(xbrl).toContain(
      '<xbrli:identifier scheme="https://ariregister.rik.ee/">17499653</xbrli:identifier>',
    );
    expect(xbrl).toContain(
      '<et-gaap:RegistryCode contextRef="i-2026-12-31">17499653</et-gaap:RegistryCode>',
    );
  });

  it('refuses to render without a registry code rather than substituting anything', () => {
    expect(() =>
      render({ declarant: { regNumber: null, name: 'Test OÜ' } }),
    ).toThrow(AnnualAccountsRenderError);
    expect(() =>
      render({ declarant: { regNumber: '   ', name: 'Test OÜ' } }),
    ).toThrow(/no commercial registry code/i);
    // A VAT number is not a registry code and must not pass as one.
    expect(() =>
      render({ declarant: { regNumber: 'EE100000001', name: 'Test OÜ' } }),
    ).toThrow(/8-digit commercial registry code/i);
  });

  it('escapes the declarant name into the instance', () => {
    const xbrl = render({
      declarant: { regNumber: '17499653', name: 'Ampersand & <Co> OÜ' },
    });
    expect(xbrl).toContain(
      '<et-gaap:CompanyName contextRef="i-2026-12-31">Ampersand &amp; &lt;Co&gt; OÜ</et-gaap:CompanyName>',
    );
    expect(validateEtGaapInstance(xbrl).errors).toEqual([]);
  });

  it('first operating year reports no comparative column at all', () => {
    const xbrl = render({
      priorPeriod: null,
      balances: [
        { code: 'BANK_EUR', type: 'asset', current: 5000, prior: 0 },
        { code: 'EQUITY', type: 'equity', current: 2500, prior: 0 },
        { code: 'REVENUE', type: 'revenue', current: 5000, prior: 0 },
        { code: 'EXPENSE_OTHER', type: 'expense', current: 2500, prior: 0 },
      ],
      periodNetIncome: 2500,
      priorNetIncome: 0,
      retainedEarningsBroughtForward: 0,
    });
    // A year that did not exist gets no invented dates.
    expect(xbrl).not.toContain('C-PRIOR');
    expect((xbrl.match(/<xbrli:context id=/g) ?? []).length).toBe(2);
    expect(validateEtGaapInstance(xbrl).errors).toEqual([]);
  });

  it('accepts a real leap day and rejects one that does not exist', () => {
    const leap = render({
      period: { name: '2024', startDate: '2024-01-01', endDate: '2024-02-29' },
      priorPeriod: null,
    });
    expect(leap).toContain('<xbrli:instant>2024-02-29</xbrli:instant>');
    expect(validateEtGaapInstance(leap).errors).toEqual([]);

    expect(() =>
      render({
        period: {
          name: '2026',
          startDate: '2026-01-01',
          endDate: '2026-02-29',
        },
        priorPeriod: null,
      }),
    ).toThrow(/not a real calendar date/);
  });

  it('rejects a day that no month has', () => {
    // yyyy-mm-dd shaped but impossible; the reporting_period row is a plain
    // string column, so this reaches the renderer unfiltered.
    expect(() =>
      render({
        period: {
          name: '2026',
          startDate: '2026-01-01',
          endDate: '2026-02-30',
        },
        priorPeriod: null,
      }),
    ).toThrow(/2026-02-30.*not a real calendar date/);
    expect(() =>
      render({
        priorPeriod: {
          name: '2025',
          startDate: '2025-01-01',
          endDate: '2025-11-31',
        },
      }),
    ).toThrow(/2025-11-31.*not a real calendar date/);
  });

  it('rejects a duration that runs backwards, in either column', () => {
    expect(() =>
      render({
        period: {
          name: '2026',
          startDate: '2026-12-31',
          endDate: '2026-01-01',
        },
        priorPeriod: null,
      }),
    ).toThrow(/Reported period starts on 2026-12-31 and ends on 2026-01-01/);
    expect(() =>
      render({
        priorPeriod: {
          name: '2025',
          startDate: '2025-12-31',
          endDate: '2025-01-01',
        },
      }),
    ).toThrow(/Comparative period starts on 2025-12-31/);
  });

  it('rejects a comparative period that overlaps the reported one', () => {
    expect(() =>
      render({
        priorPeriod: {
          name: 'overlap',
          startDate: '2025-01-01',
          endDate: '2026-06-30',
        },
      }),
    ).toThrow(/ends on 2026-06-30, on or after the reported period starts/);
  });

  it('rejects a period whose dates are not ISO dates', () => {
    expect(() =>
      render({
        period: {
          name: '2026',
          startDate: '2026-01-01',
          endDate: '31/12/2026',
        },
      }),
    ).toThrow(AnnualAccountsRenderError);
  });

  it('rejects an unsupported taxonomy version', () => {
    expect(() =>
      renderAnnualAccountsXbrl(baseInput(), {
        taxonomyVersion: 2025 as unknown as 2026,
      }),
    ).toThrow(/Unsupported RIK taxonomy version/);
  });
});

describe('the mapped concepts exist in the official taxonomy', () => {
  const concepts = etGaapConcepts();

  it.each(Object.values(RTJ_LINES).map((l) => [l.id, l.concept, l.statement]))(
    '%s → %s',
    (_id, concept, statement) => {
      const [prefix, name] = String(concept).split(':');
      expect(prefix).toBe('et-gaap');
      const declared = concepts.get(name);
      expect(declared).toBeDefined();
      expect(declared?.abstract).toBe(false);
      expect(declared?.type).toBe('xbrli:monetaryItemType');
      // A balance-sheet line is an instant concept; an income-statement line
      // is a duration concept. This is the taxonomy's own classification.
      expect(declared?.periodType).toBe(
        statement === 'balanceSheet' ? 'instant' : 'duration',
      );
    },
  );

  it('negates exactly the lines the taxonomy declares credit-balance against a debit ledger', () => {
    for (const line of Object.values(RTJ_LINES)) {
      const declared = concepts.get(line.concept.split(':')[1]);
      const expected =
        line.normalSide === 'debit' && declared?.balance === 'credit' ? -1 : 1;
      expect([line.id, line.reportedSign]).toEqual([line.id, expected]);
    }
  });
});
