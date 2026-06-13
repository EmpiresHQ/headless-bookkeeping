import { renderAnnualAccountsXbrl } from './xbrl';
import type { AnnualAccountsInput } from '../annual-accounts.types';

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
      { code: 'RETAINED_EARNINGS', type: 'equity', current: 24500, prior: 0 },
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
    // separate live ProfitLossForPeriod line.
    periodNetIncome: 16000,
    priorNetIncome: 22000,
    retainedEarningsBroughtForward: 24500,
    declarant: { regNumber: '12345678', name: 'Test OÜ' },
    ...over,
  };
}

describe('renderAnnualAccountsXbrl', () => {
  it('emits a 2026-pinned XBRL document with two comparative contexts', () => {
    const xbrl = renderAnnualAccountsXbrl(baseInput(), {
      taxonomyVersion: 2026,
    });
    expect(xbrl).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xbrl).toContain('xmlns:ee-rtj="http://www.eesti.ee/xbrl/rtj/2026"');
    // Two period contexts, current + prior.
    expect(xbrl).toContain('<xbrli:context id="C-2026">');
    expect(xbrl).toContain('<xbrli:context id="C-2025">');
    expect(xbrl).toContain('<xbrli:endDate>2026-12-31</xbrli:endDate>');
    expect(xbrl).toContain('<xbrli:endDate>2025-12-31</xbrli:endDate>');
    // Entity identifier (declarant reg number) in the mandatory context.
    expect(xbrl).toContain('>12345678</xbrli:identifier>');
  });

  it('reports the current and prior facts for a balance-sheet line', () => {
    const xbrl = renderAnnualAccountsXbrl(baseInput(), {
      taxonomyVersion: 2026,
    });
    // Cash 30000 current / 10000 prior, tagged with the right context.
    expect(xbrl).toContain(
      '<ee-rtj:CashAndCashEquivalents contextRef="C-2026" unitRef="EUR" decimals="-2">30000</ee-rtj:CashAndCashEquivalents>',
    );
    expect(xbrl).toContain(
      '<ee-rtj:CashAndCashEquivalents contextRef="C-2025" unitRef="EUR" decimals="-2">10000</ee-rtj:CashAndCashEquivalents>',
    );
    // Tangible fixed assets net of accumulated depreciation: 20000 − 4000 = 16000.
    expect(xbrl).toContain(
      '<ee-rtj:TangibleFixedAssets contextRef="C-2026" unitRef="EUR" decimals="-2">16000</ee-rtj:TangibleFixedAssets>',
    );
  });

  it('equity is three live lines: capital, brought-forward retained, period result', () => {
    const xbrl = renderAnnualAccountsXbrl(baseInput(), {
      taxonomyVersion: 2026,
    });
    expect(xbrl).toContain(
      '<ee-rtj:IssuedCapital contextRef="C-2026" unitRef="EUR" decimals="-2">2500</ee-rtj:IssuedCapital>',
    );
    expect(xbrl).toContain(
      '<ee-rtj:RetainedEarningsDeficit contextRef="C-2026" unitRef="EUR" decimals="-2">24500</ee-rtj:RetainedEarningsDeficit>',
    );
    expect(xbrl).toContain(
      '<ee-rtj:ProfitLossForPeriod contextRef="C-2026" unitRef="EUR" decimals="-2">16000</ee-rtj:ProfitLossForPeriod>',
    );
  });

  it('calculation-linkbase semantics: Aktiva = Kohustused + Omakapital', () => {
    const xbrl = renderAnnualAccountsXbrl(baseInput(), {
      taxonomyVersion: 2026,
    });
    // Total assets = cash 30000 + receivables 5000 + tangible 16000 = 51000.
    expect(xbrl).toContain(
      '<ee-rtj:TotalAssets contextRef="C-2026" unitRef="EUR" decimals="-2">51000</ee-rtj:TotalAssets>',
    );
    // L + E = AP 8000 + capital 2500 + retained b/f 24500 + period 16000 = 51000.
    expect(xbrl).toContain(
      '<ee-rtj:TotalEquityAndLiabilities contextRef="C-2026" unitRef="EUR" decimals="-2">51000</ee-rtj:TotalEquityAndLiabilities>',
    );
  });

  it('income statement totals: profit for period = revenue − expenses', () => {
    const xbrl = renderAnnualAccountsXbrl(baseInput(), {
      taxonomyVersion: 2026,
    });
    // Revenue 60000 − (otherOp 42000 + depreciation 2000) = 16000.
    expect(xbrl).toContain(
      '<ee-rtj:Revenue contextRef="C-2026" unitRef="EUR" decimals="-2">60000</ee-rtj:Revenue>',
    );
    expect(xbrl).toContain(
      '<ee-rtj:ProfitLossForPeriod contextRef="C-2026" unitRef="EUR" decimals="-2">16000</ee-rtj:ProfitLossForPeriod>',
    );
  });

  it('first operating year emits a zero prior column but still two contexts', () => {
    const input = baseInput({
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
    const xbrl = renderAnnualAccountsXbrl(input, { taxonomyVersion: 2026 });
    // A zero prior context is still emitted (RIK rejects a single period).
    expect(xbrl).toContain('<xbrli:context id="C-PRIOR">');
    expect(xbrl).toContain(
      '<ee-rtj:CashAndCashEquivalents contextRef="C-PRIOR" unitRef="EUR" decimals="-2">0</ee-rtj:CashAndCashEquivalents>',
    );
  });
});
