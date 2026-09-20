import type {
  AnnualAccountsInput,
  AnnualAccountsOpts,
} from '../annual-accounts.types';
import { AnnualAccountsRenderError } from '../annual-accounts.types';
import { RTJ_LINES, rollUpLines } from './rtj-mapping';

/**
 * The official Estonian annual-report taxonomy this renderer targets, published
 * by the Centre of Registers and Information Systems at https://xbrl.eesti.ee/.
 * `SCHEMA_REF` is the canonical URL of the core (element-declaration) schema and
 * is what an instance's `link:schemaRef` must point at. A vendored, SHA-256
 * pinned copy of that schema drives the test-suite validator — see
 * `test/fixtures/xbrl/PROVENANCE.md`.
 */
const NS = 'http://xbrl.eesti.ee/taxonomy/et-gaap_2026-01-01/';
const SCHEMA_REF = `${NS}et-gaap-cor_2026-01-01.xsd`;

/**
 * The URI identifying the kind of entity identifier carried in
 * `xbrli:identifier/@scheme`: the Estonian commercial register, whose codes the
 * declarant's `registry_code` holds. XBRL 2.1 §4.7.1 requires a scheme URI but
 * fixes no value, and RIK publishes no filing rule naming one in any source we
 * could reach, so this names the issuing register itself. Changing it is a
 * one-line change here if RIK later publishes a required scheme.
 */
const ENTITY_SCHEME = 'https://ariregister.rik.ee/';

/** 8-digit Estonian commercial registry code — mirrors the KMD declarant rule. */
const REG_RE = /^\d{8}$/;

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Ledger minor units → the monetary value the taxonomy expects, which is
 * CURRENCY UNITS (euros), not cents. `decimals` states the accuracy of a
 * reported value; it never rescales it (XBRL 2.1 §4.6.6), so reporting the cent
 * integer with `decimals="-2"` claimed a hundred-fold amount.
 *
 * Minor units are exact integers, so every value is exact to two decimal
 * places and the instance declares `decimals="2"`. A non-integer minor amount
 * is a kernel bug, not something to round away silently.
 */
export function minorToEuros(minor: number): string {
  if (!Number.isFinite(minor) || !Number.isInteger(minor)) {
    throw new AnnualAccountsRenderError(
      `Monetary amount ${minor} is not a whole number of minor units; ` +
        `the ledger cannot express a fraction of a cent`,
    );
  }
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const whole = Math.trunc(abs / 100);
  const cents = abs % 100;
  return `${negative ? '-' : ''}${whole}.${String(cents).padStart(2, '0')}`;
}

/** DECIMALS for every monetary fact: cents are exact to two places. */
const DECIMALS = '2';

/** A context id, derived from its period alone so it is collision-free. */
function instantId(date: string): string {
  return `i-${date}`;
}
function durationId(startDate: string, endDate: string): string {
  return `d-${startDate}_${endDate}`;
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A context date must be a real day, not merely yyyy-mm-dd shaped: an XBRL
 * context carrying 2026-02-30 is not a valid context, and the reporting-period
 * row these dates come from is stored as a plain string with no calendar
 * constraint, so the renderer is where the check has to happen. The round-trip
 * through `Date.UTC` rejects 2026-02-30 and 2026-02-29 while accepting
 * 2024-02-29.
 */
function requireDate(value: string, what: string): string {
  const m = ISO_DATE_RE.exec(value);
  if (!m) {
    throw new AnnualAccountsRenderError(
      `${what} ${JSON.stringify(value)} is not an ISO yyyy-mm-dd date`,
    );
  }
  const [, year, month, day] = m;
  const utc = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    utc.getUTCFullYear() !== Number(year) ||
    utc.getUTCMonth() !== Number(month) - 1 ||
    utc.getUTCDate() !== Number(day)
  ) {
    throw new AnnualAccountsRenderError(
      `${what} ${JSON.stringify(value)} is not a real calendar date`,
    );
  }
  return value;
}

/**
 * A duration context must run forwards. ISO dates compare correctly as
 * strings, so the ordering checks are plain comparisons on validated dates.
 */
function requireOrdered(
  startDate: string,
  endDate: string,
  what: string,
): void {
  if (startDate > endDate) {
    throw new AnnualAccountsRenderError(
      `${what} starts on ${startDate} and ends on ${endDate}, which runs backwards`,
    );
  }
}

/** The instant + duration contexts for one reported year. */
interface YearContexts {
  instant: string;
  duration: string;
}

export function renderAnnualAccountsXbrl(
  input: AnnualAccountsInput,
  opts: AnnualAccountsOpts,
): string {
  if (opts.taxonomyVersion !== 2026) {
    throw new AnnualAccountsRenderError(
      `Unsupported RIK taxonomy version ${opts.taxonomyVersion}`,
    );
  }

  // The declarant identity is the COMMERCIAL REGISTRY code. There is no
  // fallback: a VAT number is a different identifier in a different register,
  // and substituting it produced a filing that named the wrong entity key.
  const reg = input.declarant.regNumber?.trim() ?? '';
  if (reg === '') {
    throw new AnnualAccountsRenderError(
      'Annual accounts declarant has no commercial registry code',
    );
  }
  if (!REG_RE.test(reg)) {
    throw new AnnualAccountsRenderError(
      `Declarant registry code ${reg} must be an 8-digit commercial registry code`,
    );
  }

  const lines = rollUpLines(input.balances);
  const get = (id: string): { current: number; prior: number } =>
    lines.find((l) => l.id === id) ?? { current: 0, prior: 0 };

  // ── Contexts. Derived from the period's OWN dates, never hardcoded. A first
  //    operating year has no comparative period, so it reports no prior
  //    column — rather than inventing dates for a year that did not exist.
  const periodStart = requireDate(input.period.startDate, 'period startDate');
  const periodEnd = requireDate(input.period.endDate, 'period endDate');
  requireOrdered(periodStart, periodEnd, 'Reported period');
  const current: YearContexts = {
    instant: instantId(periodEnd),
    duration: durationId(periodStart, periodEnd),
  };

  let prior: YearContexts | null = null;
  if (input.priorPeriod) {
    const priorStart = requireDate(
      input.priorPeriod.startDate,
      'prior period startDate',
    );
    const priorEnd = requireDate(
      input.priorPeriod.endDate,
      'prior period endDate',
    );
    requireOrdered(priorStart, priorEnd, 'Comparative period');
    // The comparative must be over before the reported year opens; otherwise
    // the two columns describe overlapping time and the "prior" label is a lie.
    if (priorEnd >= periodStart) {
      throw new AnnualAccountsRenderError(
        `Comparative period ends on ${priorEnd}, on or after the reported period starts on ${periodStart}`,
      );
    }
    prior = {
      instant: instantId(priorEnd),
      duration: durationId(priorStart, priorEnd),
    };
  }

  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(
    `<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" ` +
      `xmlns:link="http://www.xbrl.org/2003/linkbase" ` +
      `xmlns:xlink="http://www.w3.org/1999/xlink" ` +
      `xmlns:et-gaap="${NS}" ` +
      `xmlns:iso4217="http://www.xbrl.org/2003/iso4217">`,
  );
  out.push(
    `  <link:schemaRef xlink:type="simple" xlink:href="${SCHEMA_REF}"/>`,
  );

  // ── Contexts ──
  const identifier = esc(reg);
  const entity =
    `    <xbrli:entity><xbrli:identifier scheme="${ENTITY_SCHEME}">` +
    `${identifier}</xbrli:identifier></xbrli:entity>`;
  const instantCtx = (id: string, date: string): string =>
    [
      `  <xbrli:context id="${id}">`,
      entity,
      `    <xbrli:period><xbrli:instant>${date}</xbrli:instant></xbrli:period>`,
      `  </xbrli:context>`,
    ].join('\n');
  const durationCtx = (id: string, start: string, end: string): string =>
    [
      `  <xbrli:context id="${id}">`,
      entity,
      `    <xbrli:period><xbrli:startDate>${start}</xbrli:startDate>` +
        `<xbrli:endDate>${end}</xbrli:endDate></xbrli:period>`,
      `  </xbrli:context>`,
    ].join('\n');

  out.push(instantCtx(current.instant, input.period.endDate));
  out.push(
    durationCtx(current.duration, input.period.startDate, input.period.endDate),
  );
  if (prior && input.priorPeriod) {
    out.push(instantCtx(prior.instant, input.priorPeriod.endDate));
    out.push(
      durationCtx(
        prior.duration,
        input.priorPeriod.startDate,
        input.priorPeriod.endDate,
      ),
    );
  }

  // ── Unit ──
  out.push(
    `  <xbrli:unit id="EUR"><xbrli:measure>iso4217:EUR</xbrli:measure></xbrli:unit>`,
  );

  const fact = (concept: string, contextRef: string, minor: number): void => {
    out.push(
      `  <${concept} contextRef="${contextRef}" unitRef="EUR" ` +
        `decimals="${DECIMALS}">${minorToEuros(minor)}</${concept}>`,
    );
  };
  const text = (concept: string, contextRef: string, value: string): void => {
    out.push(
      `  <${concept} contextRef="${contextRef}">${esc(value)}</${concept}>`,
    );
  };

  // ── General information (instant concepts, reported on the closing date) ──
  if (input.declarant.name) {
    text('et-gaap:CompanyName', current.instant, input.declarant.name);
  }
  text('et-gaap:RegistryCode', current.instant, reg);

  // ── Balance sheet — form [201012], all concepts instant ──
  const signed = (id: string, field: 'current' | 'prior'): number =>
    get(id)[field] * RTJ_LINES[id].reportedSign;

  const bs = (ctx: string, field: 'current' | 'prior'): void => {
    const cash = signed('cashAndBankAccounts', field);
    const receivables = signed('receivablesAndPrepayments', field);
    const inventories = signed('inventories', field);
    const ppe = signed('tangibleFixedAssets', field);
    const payables = signed('payablesAndPrepayments', field);
    const capital = signed('issuedCapital', field);
    const retained =
      field === 'current'
        ? input.retainedEarningsBroughtForward
        : // Prior brought-forward = prior retained line minus the prior result.
          get('retainedEarnings').prior - input.priorNetIncome;
    const result =
      field === 'current' ? input.periodNetIncome : input.priorNetIncome;

    const currentAssets = cash + receivables + inventories;
    const nonCurrentAssets = ppe;
    const assets = currentAssets + nonCurrentAssets;
    const currentLiabilities = payables;
    const liabilities = currentLiabilities;
    const equity = capital + retained + result;

    fact(RTJ_LINES.cashAndBankAccounts.concept, ctx, cash);
    fact(RTJ_LINES.receivablesAndPrepayments.concept, ctx, receivables);
    fact(RTJ_LINES.inventories.concept, ctx, inventories);
    fact('et-gaap:CurrentAssets', ctx, currentAssets);
    fact(RTJ_LINES.tangibleFixedAssets.concept, ctx, ppe);
    fact('et-gaap:NonCurrentAssets', ctx, nonCurrentAssets);
    fact('et-gaap:Assets', ctx, assets);

    fact(RTJ_LINES.payablesAndPrepayments.concept, ctx, payables);
    fact('et-gaap:CurrentLiabilities', ctx, currentLiabilities);
    fact('et-gaap:Liabilities', ctx, liabilities);

    fact(RTJ_LINES.issuedCapital.concept, ctx, capital);
    fact(RTJ_LINES.retainedEarnings.concept, ctx, retained);
    fact(RTJ_LINES.profitForPeriod.concept, ctx, result);
    fact('et-gaap:Equity', ctx, equity);
    fact('et-gaap:LiabilitiesAndEquity', ctx, liabilities + equity);
  };

  // ── Income statement — scheme 1 [301011], all concepts duration ──
  const is = (ctx: string, field: 'current' | 'prior'): void => {
    const revenue = signed('revenue', field);
    const labour = signed('labourExpense', field);
    const otherOperating = signed('otherOperatingExpenses', field);
    const depreciation = signed('depreciation', field);
    const result =
      field === 'current' ? input.periodNetIncome : input.priorNetIncome;

    fact(RTJ_LINES.revenue.concept, ctx, revenue);
    fact(RTJ_LINES.otherOperatingExpenses.concept, ctx, otherOperating);
    fact(RTJ_LINES.labourExpense.concept, ctx, labour);
    fact(RTJ_LINES.depreciation.concept, ctx, depreciation);
    // The taxonomy's calculation linkbase sums these with weight +1, and the
    // expense concepts are credit-balance, so the signed sum IS the result.
    fact('et-gaap:TotalProfitLoss', ctx, result);
    fact('et-gaap:TotalProfitLossBeforeTax', ctx, result);
    fact('et-gaap:TotalAnnualPeriodProfitLoss', ctx, result);
  };

  bs(current.instant, 'current');
  is(current.duration, 'current');
  if (prior) {
    bs(prior.instant, 'prior');
    is(prior.duration, 'prior');
  }

  out.push('</xbrli:xbrl>');
  return out.join('\n');
}
