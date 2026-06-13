import type {
  AnnualAccountsInput,
  AnnualAccountsOpts,
} from '../annual-accounts.types';
import { RTJ_LINES, rollUpLines } from './rtj-mapping';

const NS = 'http://www.eesti.ee/xbrl/rtj/2026';

/** Context ids: current period, prior period (or the synthetic zero prior). */
function contextIds(input: AnnualAccountsInput): {
  current: string;
  prior: string;
} {
  const current = `C-${input.period.name}`;
  const prior = input.priorPeriod ? `C-${input.priorPeriod.name}` : 'C-PRIOR';
  return { current, prior };
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** A single tagged fact line. Amounts are whole euros (minor units / 100 floored?
 *  No — minor units are already cents; RIK reports whole euros. We report minor
 *  units directly with decimals="-2" so the portal reads euros; v1 keeps the
 *  ledger's minor-unit integers as the reported value, matching the draft==final
 *  invariant. */
function fact(concept: string, contextRef: string, value: number): string {
  return `<${concept} contextRef="${contextRef}" unitRef="EUR" decimals="-2">${value}</${concept}>`;
}

export function renderAnnualAccountsXbrl(
  input: AnnualAccountsInput,
  opts: AnnualAccountsOpts,
): string {
  if (opts.taxonomyVersion !== 2026) {
    throw new Error(`Unsupported RIK taxonomy version ${opts.taxonomyVersion}`);
  }
  const { current, prior } = contextIds(input);
  const lines = rollUpLines(input.balances);
  const get = (id: string): { current: number; prior: number } =>
    lines.find((l) => l.id === id) ?? { current: 0, prior: 0 };

  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(
    `<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" ` +
      `xmlns:ee-rtj="${NS}" ` +
      `xmlns:iso4217="http://www.xbrl.org/2003/iso4217">`,
  );

  // ── Contexts ──
  const identifier = esc(input.declarant.regNumber ?? '');
  const ctx = (id: string, endDate: string): string =>
    [
      `  <xbrli:context id="${id}">`,
      `    <xbrli:entity><xbrli:identifier scheme="http://www.rik.ee">${identifier}</xbrli:identifier></xbrli:entity>`,
      `    <xbrli:period><xbrli:endDate>${endDate}</xbrli:endDate></xbrli:period>`,
      `  </xbrli:context>`,
    ].join('\n');
  out.push(ctx(current, input.period.endDate));
  out.push(
    ctx(prior, input.priorPeriod ? input.priorPeriod.endDate : '2025-12-31'),
  );

  // ── Unit ──
  out.push(
    `  <xbrli:unit id="EUR"><xbrli:measure>iso4217:EUR</xbrli:measure></xbrli:unit>`,
  );

  // ── Balance sheet facts ──
  const bsAssetIds = [
    'cashAndBankAccounts',
    'receivablesAndPrepayments',
    'inventories',
    'tangibleFixedAssets',
  ];
  for (const id of bsAssetIds) {
    const def = RTJ_LINES[id];
    const t = get(id);
    out.push('  ' + fact(def.concept, current, t.current));
    out.push('  ' + fact(def.concept, prior, t.prior));
  }
  const totalAssetsCurrent = bsAssetIds.reduce((s, id) => s + get(id).current, 0);
  const totalAssetsPrior = bsAssetIds.reduce((s, id) => s + get(id).prior, 0);
  out.push('  ' + fact('ee-rtj:TotalAssets', current, totalAssetsCurrent));
  out.push('  ' + fact('ee-rtj:TotalAssets', prior, totalAssetsPrior));

  // Liabilities.
  const payables = get('payablesAndPrepayments');
  out.push('  ' + fact(RTJ_LINES.payablesAndPrepayments.concept, current, payables.current));
  out.push('  ' + fact(RTJ_LINES.payablesAndPrepayments.concept, prior, payables.prior));

  // Equity — three live lines.
  const capital = get('issuedCapital');
  out.push('  ' + fact(RTJ_LINES.issuedCapital.concept, current, capital.current));
  out.push('  ' + fact(RTJ_LINES.issuedCapital.concept, prior, capital.prior));
  out.push(
    '  ' +
      fact(
        RTJ_LINES.retainedEarnings.concept,
        current,
        input.retainedEarningsBroughtForward,
      ),
  );
  out.push(
    '  ' +
      fact(
        RTJ_LINES.retainedEarnings.concept,
        prior,
        // Prior brought-forward = prior retained line minus prior result.
        get('retainedEarnings').prior - input.priorNetIncome,
      ),
  );
  out.push(
    '  ' + fact(RTJ_LINES.profitForPeriod.concept, current, input.periodNetIncome),
  );
  out.push('  ' + fact(RTJ_LINES.profitForPeriod.concept, prior, input.priorNetIncome));

  const totalEqLiabCurrent =
    payables.current +
    capital.current +
    input.retainedEarningsBroughtForward +
    input.periodNetIncome;
  const totalEqLiabPrior =
    payables.prior +
    capital.prior +
    (get('retainedEarnings').prior - input.priorNetIncome) +
    input.priorNetIncome;
  out.push(
    '  ' + fact('ee-rtj:TotalEquityAndLiabilities', current, totalEqLiabCurrent),
  );
  out.push(
    '  ' + fact('ee-rtj:TotalEquityAndLiabilities', prior, totalEqLiabPrior),
  );

  // ── Income statement facts (skeem 1) ──
  const isIds = ['revenue', 'labourExpense', 'otherOperatingExpenses', 'depreciation'];
  for (const id of isIds) {
    const def = RTJ_LINES[id];
    const t = get(id);
    out.push('  ' + fact(def.concept, current, t.current));
    out.push('  ' + fact(def.concept, prior, t.prior));
  }
  // Profit for period mirrors the equity line (same fact, income-statement total).
  out.push(
    '  ' + fact(RTJ_LINES.profitForPeriod.concept, current, input.periodNetIncome),
  );

  out.push('</xbrli:xbrl>');
  return out.join('\n');
}
