import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';

export interface DuplicateMatch {
  tier: 1 | 2;
  existingExpenseId: number;
  reason: string;
}

const WINDOW_DAYS = 7;

/** ISO YYYY-MM-DD shifted by ±days (UTC, no time component). */
function shiftIsoDate(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * DuplicateGuardService — a structured, two-tier duplicate gate over the
 * `expense` table.
 *
 * Tier 1 (exact): same supplier + same non-null printed invoice number.
 * Tier 2 (fuzzy): same supplier + same gross amount + tax point date within
 * ±WINDOW_DAYS, used only when Tier 1 found no match.
 *
 * Matches on `gross_amount`, never `vat_amount` — VAT can wobble between an
 * order confirmation and the final invoice (e.g. 10.00 vs 10.06) while the
 * gross total stays stable. A `reversed` expense is void and must never
 * block a re-post.
 */
@Injectable()
export class DuplicateGuardService {
  constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

  async check(candidate: {
    supplierId: number;
    supplierInvoiceNumber: string | null;
    grossAmount: number;
    taxPointDate: string;
  }): Promise<DuplicateMatch | null> {
    if (candidate.supplierId == null) {
      throw new Error(
        'DuplicateGuardService.check requires a resolved supplierId',
      );
    }

    // Tier 1 — exact supplier + invoice number (only when a number is printed).
    // An empty-string invoice number is deliberately treated as "no number"
    // (falsy) so it falls through to the Tier 2 fuzzy match instead of
    // matching other expenses that also lack a printed number.
    if (candidate.supplierInvoiceNumber) {
      const exact = await this.db
        .selectFrom('expense')
        .select(['id'])
        .where('supplier_id', '=', candidate.supplierId)
        .where('supplier_invoice_number', '=', candidate.supplierInvoiceNumber)
        .where('status', '!=', 'reversed')
        .orderBy('id', 'desc')
        .executeTakeFirst();
      if (exact) {
        return {
          tier: 1,
          existingExpenseId: exact.id,
          reason:
            `possible duplicate of expense #${exact.id}: same supplier ` +
            `and invoice number ${candidate.supplierInvoiceNumber}.`,
        };
      }
    }

    // Tier 2 — supplier + gross + tax_point_date within ±WINDOW_DAYS.
    const lo = shiftIsoDate(candidate.taxPointDate, -WINDOW_DAYS);
    const hi = shiftIsoDate(candidate.taxPointDate, WINDOW_DAYS);
    const fuzzy = await this.db
      .selectFrom('expense')
      .select(['id', 'tax_point_date'])
      .where('supplier_id', '=', candidate.supplierId)
      .where('gross_amount', '=', candidate.grossAmount)
      .where('tax_point_date', '>=', lo)
      .where('tax_point_date', '<=', hi)
      .where('status', '!=', 'reversed')
      .orderBy('id', 'desc')
      .executeTakeFirst();
    if (fuzzy) {
      return {
        tier: 2,
        existingExpenseId: fuzzy.id,
        reason:
          `possible duplicate of expense #${fuzzy.id}: same supplier, ` +
          `gross amount ${(candidate.grossAmount / 100).toFixed(2)}, tax point ` +
          `${candidate.taxPointDate} (existing ${fuzzy.tax_point_date}).`,
      };
    }

    return null;
  }
}
