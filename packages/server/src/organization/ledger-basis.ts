import { PluginLoader } from '../plugins/plugin-loader.service';

/**
 * The organisation settings that decide HOW a ledger amount is measured
 * (issue #215).
 *
 * A posted VoucherLine stores `base_amount` as a bare integer — the basis it
 * was measured in is not written on the line, it is the organisation's. So
 * these two fields are not ordinary profile fields: they are the unit of the
 * numbers already in the ledger.
 *
 *  - `base_currency` (with `country` supplying the plugin default) fixes the
 *    CURRENCY those amounts are denominated in;
 *  - `country` additionally fixes the JURISDICTION whose plugin supplied the
 *    reference rate, the minor-unit rounding and the VAT treatment they were
 *    booked under (ADR-0002/ADR-0004).
 *
 * Changing either after a Voucher exists silently redefines the unit of every
 * amount already posted, so `Σ base_amount` starts adding EUR-measured cents to
 * USD-measured cents. Nothing in the data flags it: the aggregate is simply
 * wrong and stays wrong.
 */
export interface OrganizationBasisRow {
  country: string;
  /** NULL = inherit the country plugin's default base currency (ADR-0004). */
  base_currency: string | null;
}

/**
 * The EFFECTIVE measurement basis: the currency actually applied plus the
 * jurisdiction that governed it.
 */
export interface LedgerBasis {
  country: string;
  baseCurrency: string;
}

/**
 * The effective base currency, given an ALREADY-RESOLVED country plugin — for
 * a caller that holds the plugin (via `OrgContextResolver.resolve`) and must
 * not resolve it a second time, or is inside a transaction where it cannot.
 */
export function effectiveBaseCurrency(
  org: OrganizationBasisRow,
  plugin: { getDefaultBaseCurrency(): string },
): string {
  // Falsy, not just null: an empty override has always fallen through to the
  // plugin default here, and the guard must read the column the same way the
  // posting side does.
  return org.base_currency
    ? org.base_currency
    : plugin.getDefaultBaseCurrency();
}

/**
 * Resolve the effective basis of an organisation row — the SINGLE definition of
 * "which currency are the base amounts in" (ADR-0004 resolution order: the
 * explicit override, else the country plugin's default).
 *
 * {@link CurrencyService.getBaseCurrency} resolves through here, so the guard
 * compares exactly what the posting side would go on to use — not the raw
 * column, which can change (`'EUR'` ⇄ `null` under an EUR-default plugin)
 * without the measurement changing at all.
 */
export function resolveLedgerBasis(
  org: OrganizationBasisRow,
  pluginLoader: PluginLoader,
): LedgerBasis {
  return {
    country: org.country,
    baseCurrency: effectiveBaseCurrency(org, pluginLoader.resolve(org.country)),
  };
}

/** True when two effective bases measure amounts identically. */
export function sameLedgerBasis(a: LedgerBasis, b: LedgerBasis): boolean {
  return a.country === b.country && a.baseCurrency === b.baseCurrency;
}

/** Human-readable form for an error message: `EUR (EE)`. */
export function describeLedgerBasis(basis: LedgerBasis): string {
  return `${basis.baseCurrency} (${basis.country})`;
}

/**
 * True when the two raw rows are byte-identical — the conservative check used
 * at the posting seam, where no plugin is available to resolve defaults.
 *
 * Raw equality implies effective equality, so this never lets a real basis
 * change through. The converse does not hold: an effect-FREE edit
 * (`'EUR'` → `null` under an EUR-default plugin) stays permitted at any time,
 * ledger or no ledger, and will register here as a difference. The cost of that
 * is a transient rejection of a post that happened to be in flight across the
 * edit — nothing is written, the caller retries — which is the right trade
 * against mislabelling an amount.
 */
export function sameBasisRow(
  a: OrganizationBasisRow,
  b: OrganizationBasisRow,
): boolean {
  return a.country === b.country && a.base_currency === b.base_currency;
}
