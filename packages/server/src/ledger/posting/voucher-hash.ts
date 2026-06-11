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
 * H(N) = SHA-256(prevHash ‖ canonical(N)), where canonical(N) is a
 * deterministic JSON serialization of the voucher's immutable fields
 * plus all its lines — but NOT the previous_hash field itself.
 *
 * The `prevHash` is prepended to the JSON string before hashing, making
 * the chain truly cryptographic (each voucher commits to the full prior
 * state, not just its own data). ADR-0013.
 *
 * When `previous_hash` is null (historic vouchers pre-hash-chain), the
 * GENESIS_HASH is used as the concatenation base so the function never
 * produces a hash that depends on a nullable field.
 */
export function computeVoucherHash(
  voucher: HashableVoucher,
  lines: HashableLine[],
): string {
  const canonical = JSON.stringify({
    voucher_number: voucher.voucher_number,
    tax_point_date: voucher.tax_point_date,
    posted_at: voucher.posted_at,
    lines: lines.map((l) => ({
      account_id: l.account_id,
      amount: l.amount,
      currency: l.currency,
      base_amount: l.base_amount,
      fx_rate: l.fx_rate,
      is_debit: l.is_debit ? 1 : 0,
    })),
  });
  const prevHash = voucher.previous_hash ?? GENESIS_HASH;
  return createHash('sha256')
    .update(prevHash + canonical)
    .digest('hex');
}
