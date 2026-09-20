/**
 * Emit one annual-accounts XBRL instance through the real plugin, for the
 * out-of-band Arelle conformance run:
 *
 *   npx ts-node --transpile-only test/xbrl/emit-sample-instance.ts /tmp/sample.xbrl
 *   ./test/xbrl/arelle-validate.sh /tmp/sample.xbrl
 *
 * The figures are a self-consistent two-year väikeettevõtja case: both columns
 * balance, and the income statement sums to the reported result, so a
 * calculation inconsistency reported by Arelle is a renderer defect and not a
 * fixture artefact.
 */
import { EstoniaCountryPlugin } from '../../src/plugins/estonia-country.plugin';
import type { AnnualAccountsInput } from '../../src/plugins/annual-accounts.types';
import { writeFileSync } from 'fs';

const input: AnnualAccountsInput = {
  period: { name: '2026', startDate: '2026-01-01', endDate: '2026-12-31' },
  priorPeriod: { name: '2025', startDate: '2025-01-01', endDate: '2025-12-31' },
  mode: 'final',
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
    { code: 'RETAINED_EARNINGS', type: 'equity', current: 24500, prior: 24500 },
    { code: 'REVENUE', type: 'revenue', current: 60000, prior: 30000 },
    { code: 'EXPENSE_OTHER', type: 'expense', current: 42000, prior: 6000 },
    { code: 'EXPENSE_SALARY', type: 'expense', current: 0, prior: 0 },
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
  periodNetIncome: 16000,
  priorNetIncome: 22000,
  retainedEarningsBroughtForward: 24500,
  declarant: { regNumber: '17499653', name: 'Test OÜ' },
};

// `generateAnnualAccounts` never reaches the FX seam, so the plugin is
// constructed with a null service rather than a live one.
const plugin = new EstoniaCountryPlugin(
  null as unknown as ConstructorParameters<typeof EstoniaCountryPlugin>[0],
);
const res = plugin.generateAnnualAccounts(input, { taxonomyVersion: 2026 });
console.log('warnings:', JSON.stringify(res.warnings));
writeFileSync(process.argv[2], res.artifacts[0].content);
console.log('wrote', process.argv[2], res.artifacts[0].filename);
