import { NULL_VAT_CODE } from '../ledger/posting/vat-constants';

/**
 * The narrowly trusted year-end adjustment path (issue #207).
 *
 * A financial year is closed months after the last month of that year has been
 * filed as a VAT return: the December KMD is due on 20 January, the annual
 * report up to six months after the year end. The year-end adjustments the
 * annual accounts are built on — the annual depreciation charge (ADR-0035) —
 * are dated ON the year's last day, which by then sits inside a LOCKED VAT
 * period. Without a defined route the close would either be impossible or would
 * force a filed return to be reopened, which ADR-0009/ADR-0012 forbid outright.
 *
 * The route is a capability, not a heuristic. It is NOT granted by a voucher's
 * `reason` text, by a "system-generated" flag or by an amount happening to
 * carry no VAT — all three are forgeable or coincidental. It is granted by the
 * caller declaring {@link PostingSemantics} `annual-close` with the financial
 * year it is closing, which only `AnnualAccountsService.finalize` constructs,
 * and it is then VALIDATED on every axis below before a single row is written:
 *
 *  1. the declared financial year exists, has `kind = 'annual'` and is OPEN;
 *  2. the voucher's tax-point date falls inside that financial year;
 *  3. every line is on {@link ANNUAL_CLOSE_ACCOUNT_CODES} — the year-end
 *     adjustment accounts, which contain no VAT-control account;
 *  4. no line carries VAT metadata (a real `vat_code`), so nothing that could
 *     belong on a declaration can ride along on a whitelisted account;
 *  5. the date is not inside a LOCKED financial year — a closed year is
 *     immutable for everyone, including this path.
 *
 * Only then is a LOCKED VAT period relaxed, and the resulting voucher is
 * stamped with `voucher.annual_close_period_id` (server-written, immutable once
 * posted) so every later reader can tell a year-end adjustment from ordinary
 * activity without trusting free text.
 */

/**
 * The accounts a year-end adjustment may touch: the depreciation charge and the
 * accumulated-depreciation contra accounts it credits (ADR-0035). Deliberately
 * an explicit list — widening it is a deliberate act, reviewed on its own
 * merits, not a side effect of some other change.
 */
export const ANNUAL_CLOSE_ACCOUNT_CODES: readonly string[] = [
  'DEPRECIATION_EXPENSE',
  'ACCUM_DEPRECIATION_VEHICLES',
  'ACCUM_DEPRECIATION_IT',
  'ACCUM_DEPRECIATION_EQUIPMENT',
  'ACCUM_DEPRECIATION_FURNITURE',
];

/**
 * The placeholder VAT code the pipeline tags non-VAT control lines with. A line
 * carrying it declares "no VAT treatment", which is what a year-end adjustment
 * must be; any other code is real VAT metadata and is rejected.
 */
export const ANNUAL_CLOSE_ALLOWED_VAT_CODES: readonly (string | null)[] = [
  null,
  NULL_VAT_CODE,
];
