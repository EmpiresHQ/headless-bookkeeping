import { createHash } from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);

interface HashableVoucher {
  voucher_number: string;
  tax_point_date: string;
  posted_at: number | null;
  previous_hash: string | null;
}

interface HashableLine {
  account_id: number;
  amount: number;
  currency: string;
  base_amount: number;
  fx_rate: number;
  is_debit: boolean;
}

/**
 * H(N) = SHA-256(canonical(N)), where canonical folds in the previous voucher's
 * hash via `previous_hash`. The field list + ordering is a forever-contract
 * (ADR-0013); changing it requires a new ADR + migration story.
 */
export function computeVoucherHash(
  voucher: HashableVoucher,
  lines: HashableLine[],
): string {
  const canonical = JSON.stringify({
    voucher_number: voucher.voucher_number,
    tax_point_date: voucher.tax_point_date,
    posted_at: voucher.posted_at,
    previous_hash: voucher.previous_hash,
    lines: lines.map((l) => ({
      account_id: l.account_id,
      amount: l.amount,
      currency: l.currency,
      base_amount: l.base_amount,
      fx_rate: l.fx_rate,
      is_debit: l.is_debit ? 1 : 0,
    })),
  });
  return createHash('sha256').update(canonical).digest('hex');
}
